/*
  Server-side logic for the login system. Implements authentication,
  role-based routing, password recovery, auditing logs, and admin actions.

  All functions are designed for Google Apps Script and interact with
  Sheets as the backing datastore.
*/
const CONFIG = {
  SPREADSHEET_ID: 'YOUR-SPREADSHEET-ID-HERE',
  USER_SHEET_NAME: 'Users',
  LOGS_SHEET_NAME: 'Logs',
  USER_HEADERS: ['Username','Password','Salt','Status','Role','Name','Last Name','Email'],
  LOG_HEADERS: ['Record ID','Username','Log Event','Date','Time','Details','Status'],
  RECOVERY_SHEET_NAME: 'Password Recovery',
  RECOVERY_HEADERS: ['Record ID','Username','Email','Code','Expires','Used']
};

// Single Spreadsheet instance used across all operations
const spreadsheet = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);

/**
 * HTTP GET handler. Renders the requested page template.
 * Defaults to `login` when no page parameter is provided.
 */
function doGet(e) {
  ensureDefaultAdmin();
  const pageName = e && e.parameter && e.parameter.page ? e.parameter.page : 'login';
  const template = HtmlService.createTemplateFromFile(pageName);
  return template
    .evaluate()
    .addMetaTag('viewport','width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * Validates user credentials and returns the HTML page content
 * for the role (`admin` or `user`). Upgrades legacy plaintext
 * passwords to salted hashes transparently on first successful login.
 */
function validateLogin(username, password) {
  const userManagementSheet = getOrCreateSheet(spreadsheet, CONFIG.USER_SHEET_NAME, CONFIG.USER_HEADERS);
  const logsSheet = getOrCreateSheet(spreadsheet, CONFIG.LOGS_SHEET_NAME, CONFIG.LOG_HEADERS);

  const rows = userManagementSheet.getDataRange().getValues();
  if (rows.length < 2) {
    appendLoginLog(logsSheet, username, 'Failed Login', 'No users available.', false);
    return { success: false, message: 'Error: Invalid username or password.' };
  }

  const headers = rows[0];
  const headerIndex = getHeaderIndexMap(headers);

  let matchedUserRow = null;
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const storedUser = row[headerIndex['Username']];
    const storedPass = row[headerIndex['Password']];
    const saltIdx = headerIndex['Salt'] !== undefined ? headerIndex['Salt'] : -1;
    const salt = saltIdx !== -1 ? row[saltIdx] : '';
    const matches = storedUser === username && (
      (salt && storedPass && hashPassword(password, salt) === storedPass) ||
      (!salt && storedPass === password)
    );
    if (matches) {
      matchedUserRow = row;
      if (!salt) {
        const newSalt = generateSalt();
        const newHash = hashPassword(password, newSalt);
        const rowIndex = i + 1;
        userManagementSheet.getRange(rowIndex, headerIndex['Password'] + 1).setValue(newHash);
        userManagementSheet.getRange(rowIndex, headerIndex['Salt'] + 1).setValue(newSalt);
      }
      break;
    }
  }

  if (!matchedUserRow) {
    appendLoginLog(logsSheet, username, 'Failed Login', `Username: ${username}, Reason: Invalid credentials.`, false);
    return { success: false, message: 'Error: Invalid username or password.' };
  }

  if (matchedUserRow[headerIndex['Status']] !== 'Active') {
    appendLoginLog(logsSheet, username, 'Inactive Account', `Username: ${username}, Reason: Account is inactive.`, false);
    return { success: false, message: 'Error: Account is not active.' };
  }

  appendLoginLog(
    logsSheet,
    username,
    'Successful Login',
    `Username: ${username}, Name: ${matchedUserRow[headerIndex['Name']]}, Email: ${matchedUserRow[headerIndex['Email']]}.`,
    true
  );

  const role = matchedUserRow[headerIndex['Role']] || 'User';
  const pageName = role === 'Admin' ? 'admin' : 'user';
  const template = HtmlService.createTemplateFromFile(pageName);
  template.username = username;
  template.name = matchedUserRow[headerIndex['Name']];
  template.lastName = matchedUserRow[headerIndex['Last Name']];
  template.email = matchedUserRow[headerIndex['Email']];
  template.role = role;
  return template.evaluate().getContent();
}

/**
 * Returns a sheet by name, creating it if missing.
 * Ensures the header row matches `headers`.
 */
function getOrCreateSheet(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (lastRow === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  } else {
    const currentHeaders = sheet.getRange(1, 1, 1, Math.max(headers.length, lastCol)).getValues()[0];
    let needsUpdate = false;
    for (let i = 0; i < headers.length; i++) {
      if (currentHeaders[i] !== headers[i]) { needsUpdate = true; break; }
    }
    if (needsUpdate) sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  }
  return sheet;
}

/** Maps header names to column indices for easy access */
function getHeaderIndexMap(headers) {
  const index = {};
  for (let i = 0; i < headers.length; i++) index[headers[i]] = i;
  return index;
}

/**
 * Appends an audit log entry to the Logs sheet with timestamp.
 */
function appendLoginLog(sheet, username, event, details, success) {
  const timestamp = new Date();
  const timezone = Session.getScriptTimeZone();
  const date = Utilities.formatDate(timestamp, timezone, 'MM/dd/yyyy');
  const time = Utilities.formatDate(timestamp, timezone, 'HH:mm:ss');
  sheet.appendRow([
    Utilities.getUuid(),
    username || 'Unknown',
    event,
    date,
    time,
    details,
    success ? 'Success' : 'Failure'
  ]);
}

/**
 * Initiates password recovery for a user identified by
 * username or email. Sends a 6-digit code via email and
 * enforces cooldown and single active code per user.
 */
function processPasswordRecovery(identifier) {
  const usersSheet = getOrCreateSheet(spreadsheet, CONFIG.USER_SHEET_NAME, CONFIG.USER_HEADERS);
  const logsSheet = getOrCreateSheet(spreadsheet, CONFIG.LOGS_SHEET_NAME, CONFIG.LOG_HEADERS);
  const recoverySheet = getOrCreateSheet(spreadsheet, CONFIG.RECOVERY_SHEET_NAME, CONFIG.RECOVERY_HEADERS);
  const rows = usersSheet.getDataRange().getValues();
  if (rows.length < 2) {
    appendLoginLog(logsSheet, identifier, 'Password Recovery Failed', 'No users available.', false);
    return { success: false, message: 'User not found.' };
  }
  const headers = rows[0];
  const idx = getHeaderIndexMap(headers);
  let match = null;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (normalizeIdentifier(r[idx['Username']]) === normalizeIdentifier(identifier) || normalizeIdentifier(r[idx['Email']]) === normalizeIdentifier(identifier)) { match = r; break; }
  }
  if (!match) {
    appendLoginLog(logsSheet, identifier, 'Password Recovery Attempt', 'User not found.', false);
    return { success: true };
  }
  const username = match[idx['Username']];
  const email = match[idx['Email']];
  const recRows = recoverySheet.getDataRange().getValues();
  let lastSent = 0;
  for (let i=1;i<recRows.length;i++){
    const r=recRows[i];
    if (normalizeIdentifier(r[1])===normalizeIdentifier(username)){
      const expTime = new Date(r[4]).getTime();
      const sentTime = expTime - 10*60*1000;
      if (!isNaN(sentTime) && sentTime>lastSent) lastSent = sentTime;
      if (r[5]==='No') recoverySheet.getRange(i+1,6).setValue('Yes');
    }
  }
  if (Date.now() - lastSent < 60*1000) {
    appendLoginLog(logsSheet, username, 'Password Recovery Throttled', 'Cooldown not met.', false);
    return { success: false, message: 'Please wait before requesting another code.' };
  }
  const code = generateRecoveryCode();
  const expires = new Date(Date.now() + 10*60*1000);
  recoverySheet.appendRow([Utilities.getUuid(), username, email, code, expires, 'No']);
  MailApp.sendEmail(email, 'Password Recovery Code', 'Your verification code is: ' + code);
  appendLoginLog(logsSheet, username, 'Password Recovery Code Sent', 'Code sent to registered email.', true);
  return { success: true };
}

/**
 * Resets the user's password using a valid recovery code.
 * Validates code, enforces password strength, and marks
 * the recovery record as used upon success.
 */
function resetPassword(identifier, code, newPassword) {
  const usersSheet = getOrCreateSheet(spreadsheet, CONFIG.USER_SHEET_NAME, CONFIG.USER_HEADERS);
  const logsSheet = getOrCreateSheet(spreadsheet, CONFIG.LOGS_SHEET_NAME, CONFIG.LOG_HEADERS);
  const recoverySheet = getOrCreateSheet(spreadsheet, CONFIG.RECOVERY_SHEET_NAME, CONFIG.RECOVERY_HEADERS);
  if (!isStrongPassword(newPassword)) {
    appendLoginLog(logsSheet, identifier, 'Password Reset Failed', 'Weak password.', false);
    return { success: false, message: 'Password must be at least 8 chars with letters and numbers.' };
  }
  const recRows = recoverySheet.getDataRange().getValues();
  let recRow = null, recRowIndex = -1;
  for (let i = 1; i < recRows.length; i++) {
    const r = recRows[i];
    const used = r[5];
    const validId = normalizeIdentifier(r[1]) === normalizeIdentifier(identifier) || normalizeIdentifier(r[2]) === normalizeIdentifier(identifier);
    const validCode = String(r[3]).trim() === String(code).trim();
    const notExpired = isNotExpired(r[4]);
    if (validId && validCode && used !== 'Yes' && notExpired) { recRow = r; recRowIndex = i+1; break; }
  }
  if (!recRow) {
    appendLoginLog(logsSheet, identifier, 'Password Reset Failed', 'Invalid or expired code.', false);
    return { success: false, message: 'Invalid or expired code.' };
  }
  const userRows = usersSheet.getDataRange().getValues();
  const headers = userRows[0];
  const idx = getHeaderIndexMap(headers);
  let userRowIndex = -1;
  for (let i = 1; i < userRows.length; i++) {
    const r = userRows[i];
    if (r[idx['Username']] === recRow[1] || r[idx['Email']] === recRow[2]) { userRowIndex = i+1; break; }
  }
  if (userRowIndex === -1) {
    appendLoginLog(logsSheet, recRow[1], 'Password Reset Failed', 'User not found during reset.', false);
    return { success: false, message: 'User not found.' };
  }
  const newSalt = generateSalt();
  const newHash = hashPassword(newPassword, newSalt);
  usersSheet.getRange(userRowIndex, idx['Password']+1).setValue(newHash);
  usersSheet.getRange(userRowIndex, idx['Salt']+1).setValue(newSalt);
  recoverySheet.getRange(recRowIndex, 6).setValue('Yes');
  appendLoginLog(logsSheet, recRow[1], 'Password Reset Success', 'Password updated.', true);
  return { success: true };
}

/** Generates a random salt string for hashing */
function generateSalt() {
  return Utilities.getUuid().replace(/-/g,'');
}

/**
 * Computes SHA-256 hash of `salt:password` and returns hex string.
 */
function hashPassword(password, salt) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + ':' + password, Utilities.Charset.UTF_8);
  return toHex(bytes);
}

/** Converts a byte array to a hex string */
function toHex(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const v = (bytes[i] + 256) % 256;
    out += v.toString(16).padStart(2,'0');
  }
  return out;
}

/** Normalizes strings for identity matching (trim + lowercase) */
function normalizeIdentifier(s) {
  return String(s || '').trim().toLowerCase();
}

/** Returns true if the `expires` time is in the future */
function isNotExpired(expires) {
  const t = expires instanceof Date ? expires.getTime() : new Date(expires).getTime();
  return !isNaN(t) && Date.now() <= t;
}

/** Checks if the given username has the Admin role */
function isAdmin(actorUsername){
  const usersSheet = getOrCreateSheet(spreadsheet, CONFIG.USER_SHEET_NAME, CONFIG.USER_HEADERS);
  const rows = usersSheet.getDataRange().getValues();
  const headers = rows[0];
  const idx = getHeaderIndexMap(headers);
  for(let i=1;i<rows.length;i++){
    const r=rows[i];
    if(normalizeIdentifier(r[idx['Username']])===normalizeIdentifier(actorUsername)){
      return (r[idx['Role']]||'User')==='Admin';
    }
  }
  return false;
}

/**
 * Returns a basic list of users for admin views.
 * Requires the caller to be an Admin.
 */
function getUsers(actorUsername){
  if(!isAdmin(actorUsername)) return {success:false,message:'Unauthorized'};
  const usersSheet = getOrCreateSheet(spreadsheet, CONFIG.USER_SHEET_NAME, CONFIG.USER_HEADERS);
  const rows = usersSheet.getDataRange().getValues();
  const headers = rows[0];
  const idx = getHeaderIndexMap(headers);
  const out=[];
  for(let i=1;i<rows.length;i++){
    const r=rows[i];
    if(!r[idx['Username']]) continue;
    out.push({
      username:r[idx['Username']],
      status:r[idx['Status']]||'Active',
      role:r[idx['Role']]||'User',
      name:r[idx['Name']]||'',
      lastName:r[idx['Last Name']]||'',
      email:r[idx['Email']]||''
    });
  }
  return {success:true,users:out};
}

/** Updates a user's role. Only Admins can perform this action. */
function updateUserRole(actorUsername,targetUsername,newRole){
  if(!isAdmin(actorUsername)) return {success:false,message:'Unauthorized'};
  const usersSheet = getOrCreateSheet(spreadsheet, CONFIG.USER_SHEET_NAME, CONFIG.USER_HEADERS);
  const rows = usersSheet.getDataRange().getValues();
  const headers = rows[0];
  const idx = getHeaderIndexMap(headers);
  let targetRowIndex=-1;
  for(let i=1;i<rows.length;i++){
    const r=rows[i];
    if(normalizeIdentifier(r[idx['Username']])===normalizeIdentifier(targetUsername)){
      targetRowIndex=i+1;break;
    }
  }
  if(targetRowIndex===-1) return {success:false,message:'User not found'};
  usersSheet.getRange(targetRowIndex, idx['Role']+1).setValue(newRole);
  const logsSheet = getOrCreateSheet(spreadsheet, CONFIG.LOGS_SHEET_NAME, CONFIG.LOG_HEADERS);
  appendLoginLog(logsSheet, actorUsername, 'Role Change', `Changed role for ${targetUsername} to ${newRole}`, true);
  return {success:true};
}

/**
 * Creates a new user with salted+hashed password.
 * Only Admins can perform this action.
 */
function createUser(actorUsername, user){
  if(!isAdmin(actorUsername)) return {success:false,message:'Unauthorized'};
  const usersSheet = getOrCreateSheet(spreadsheet, CONFIG.USER_SHEET_NAME, CONFIG.USER_HEADERS);
  const rows = usersSheet.getDataRange().getValues();
  const headers = rows[0];
  const idx = getHeaderIndexMap(headers);
  const required = ['username','password','name','lastName','email'];
  for(var k of required){ if(!user[k]) return {success:false,message:'Missing '+k}; }
  if(!isValidEmail(user.email)) return {success:false,message:'Invalid email'};
  if(!isStrongPassword(user.password)) return {success:false,message:'Weak password'};
  for(let i=1;i<rows.length;i++){
    const r=rows[i];
    if(normalizeIdentifier(r[idx['Username']])===normalizeIdentifier(user.username)){
      return {success:false,message:'Username already exists'};
    }
  }
  const salt=generateSalt();
  const hash=hashPassword(user.password,salt);
  const status=user.status||'Active';
  const role=user.role||'User';
  const row=[user.username,hash,salt,status,role,user.name,user.lastName,user.email];
  usersSheet.appendRow(row);
  const logsSheet = getOrCreateSheet(spreadsheet, CONFIG.LOGS_SHEET_NAME, CONFIG.LOG_HEADERS);
  appendLoginLog(logsSheet, actorUsername, 'User Created', `Created user ${user.username} role ${role}`, true);
  return {success:true};
}

/**
 * Ensures a default Admin account exists on first run.
 * Username: `admin`, Password: `Admin123!`
 */
function ensureDefaultAdmin(){
  const usersSheet = getOrCreateSheet(spreadsheet, CONFIG.USER_SHEET_NAME, CONFIG.USER_HEADERS);
  if (usersSheet.getLastRow() < 2) {
    const salt = generateSalt();
    const hash = hashPassword('Admin123!', salt);
    usersSheet.appendRow(['admin', hash, salt, 'Active', 'Admin', 'Admin', '', 'admin@example.com']);
  }
}

/** Basic email validation */
function isValidEmail(email){
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email||''));
}

/** Password strength: min 8 chars, letters and numbers */
function isStrongPassword(p){
  return typeof p==='string' && p.length>=8 && /[A-Za-z]/.test(p) && /[0-9]/.test(p);
}
/**
 * Changes the caller's password after verifying the current password.
 * Enforces strength and records audit logs.
 */
function changePassword(actorUsername, currentPassword, newPassword){
  const usersSheet = getOrCreateSheet(spreadsheet, CONFIG.USER_SHEET_NAME, CONFIG.USER_HEADERS);
  const logsSheet = getOrCreateSheet(spreadsheet, CONFIG.LOGS_SHEET_NAME, CONFIG.LOG_HEADERS);
  if(!isStrongPassword(newPassword)) return {success:false,message:'Password must be at least 8 chars with letters and numbers.'};
  const rows = usersSheet.getDataRange().getValues();
  const headers = rows[0];
  const idx = getHeaderIndexMap(headers);
  for(let i=1;i<rows.length;i++){
    const r=rows[i];
    if(normalizeIdentifier(r[idx['Username']])===normalizeIdentifier(actorUsername)){
      const salt = r[idx['Salt']]||'';
      const stored = r[idx['Password']]||'';
      const matches = salt ? hashPassword(currentPassword,salt)===stored : currentPassword===stored;
      if(!matches){ appendLoginLog(logsSheet, actorUsername, 'Change Password Failed', 'Current password mismatch.', false); return {success:false,message:'Current password is incorrect.'}; }
      const newSalt=generateSalt(); const newHash=hashPassword(newPassword,newSalt);
      usersSheet.getRange(i+1, idx['Password']+1).setValue(newHash);
      usersSheet.getRange(i+1, idx['Salt']+1).setValue(newSalt);
      appendLoginLog(logsSheet, actorUsername, 'Change Password Success', 'Password updated.', true);
      return {success:true};
    }
  }
  return {success:false,message:'User not found.'};
}

/**
 * Server-side render helper to return raw HTML for a given page.
 */
function renderPage(pageName){
  const t = HtmlService.createTemplateFromFile(pageName);
  return t.evaluate().getContent();
}

/**
 * Generates a 6-digit numeric recovery code derived from SHA-256
 * to reduce predictability while remaining human-friendly.
 */
function generateRecoveryCode(){
  const seed = Utilities.getUuid() + ':' + Date.now();
  const hex = toHex(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, seed, Utilities.Charset.UTF_8));
  return String((parseInt(hex.slice(-8),16) % 1000000)).padStart(6,'0');
}

/**
 * Marks expired recovery codes as used to prevent reuse attempts.
 */
function cleanupRecoveryCodes(){
  const sheet = getOrCreateSheet(spreadsheet, CONFIG.RECOVERY_SHEET_NAME, CONFIG.RECOVERY_HEADERS);
  const rows = sheet.getDataRange().getValues();
  for(let i=1;i<rows.length;i++){
    const r=rows[i];
    if(r[5]==='No' && !isNotExpired(r[4])){ sheet.getRange(i+1,6).setValue('Yes'); }
  }
  return {success:true};
}
