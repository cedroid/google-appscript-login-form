
/**
 * Handles HTTP GET requests and serves the requested HTML page.
 * @param {Object} e - The event parameter containing request details.
 * @returns {HtmlOutput} The rendered HTML page.
 */

function doGet(e) {
  const page = e.parameter.page || 'index';
  const template = HtmlService.createTemplateFromFile(page);
  return template.evaluate()
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// Access the spreadsheet database
const spreadsheet = SpreadsheetApp.openById('your-spreadsheet-id');

/**
 * Validates user login credentials.
 * @param {string} username - The username entered.
 * @param {string} password - The password entered.
 * @returns {Object} Login response containing success status and message or HTML content.
 */

function validateLogin(username, password) {
  Logger.log(`Validating login for username: ${username}`);
  const userSheet = spreadsheet.getSheetByName('User Management');
  const logSheet = spreadsheet.getSheetByName('Logs');

  if (!userSheet || !logSheet) {
    throw new Error('Required sheets not found.');
  }

  const userData = userSheet.getDataRange().getValues();
  const headers = userData[0];
  const usernameIndex = headers.indexOf('Username');
  const passwordIndex = headers.indexOf('Password');
  const statusIndex = headers.indexOf('Status');
  const nameIndex = headers.indexOf('Name');
  const lastNameIndex = headers.indexOf('Last Name');
  const emailIndex = headers.indexOf('Email');

  if ([usernameIndex, passwordIndex, statusIndex, nameIndex, lastNameIndex, emailIndex].includes(-1)) {
    throw new Error('Required columns are missing from "User Management" sheet.');
  }

  for (let i = 1; i < userData.length; i++) {
    const row = userData[i];
    if (row[usernameIndex] === username && row[passwordIndex] === password) {
      if (row[statusIndex] !== 'Active') {
        logLoginEvent(logSheet, username, 'Inactive Account', 'Account is inactive.', false);
        return { success: false, message: 'Account is not active.' };
      }
      
      logLoginEvent(logSheet, username, 'Successful Login', `Logged in successfully as ${row[nameIndex]}`, true);
      
      // Create HTML template and pass data dynamically
      const template = HtmlService.createTemplateFromFile('index');
      template.username = username;
      template.name = row[nameIndex];
      template.lastName = row[lastNameIndex];
      template.email = row[emailIndex];
      
      Logger.log(`Login successful for username: ${username}, Name: ${row[nameIndex]}, Last Name: ${row[lastNameIndex]}, Email: ${row[emailIndex]}`);
      return template.evaluate().getContent();
    }
  }
  logLoginEvent(logSheet, username, 'Failed Login', 'Invalid credentials.', false);
  return { success: false, message: 'Invalid username or password.' };
}

/**
 * Logs login attempts to the 'Logs' sheet.
 * @param {Sheet} logSheet - The Logs sheet object.
 * @param {string} username - The username attempting the login.
 * @param {string} event - The event type (e.g., 'Successful Login', 'Failed Login').
 * @param {string} details - Additional details about the login attempt.
 * @param {boolean} success - Whether the login was successful.
 */

function logLoginEvent(logSheet, username, event, details, success) {
  const timestamp = new Date();
  logSheet.appendRow([
    Utilities.getUuid(),
    username || 'Unknown',
    event,
    Utilities.formatDate(timestamp, Session.getScriptTimeZone(), 'MM/dd/yyyy'),
    Utilities.formatDate(timestamp, Session.getScriptTimeZone(), 'HH:mm:ss'),
    details,
    success ? 'Success' : 'Failure'
  ]);
}
