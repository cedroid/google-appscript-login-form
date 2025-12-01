/**
 * Runs a small suite of unit/integration tests for critical utilities
 * and flows. Intended to be triggered manually from the Apps Script editor.
 */
function runUnitTests(){
  var results = [];
  results.push(testNormalizeIdentifier());
  results.push(testIsNotExpired());
  results.push(testGenerateRecoveryCode());
  results.push(testIntegrationLoginRecovery());
  return results;
}

// Minimal assertion helpers
function assertTrue(name, cond){ return {name:name, pass: !!cond}; }
function assertEqual(name, a, b){ return {name:name, pass: a===b}; }

// Verifies normalized comparison behavior
function testNormalizeIdentifier(){
  return assertEqual('normalizeIdentifier', normalizeIdentifier('  TeSt@Mail.com  '), 'test@mail.com');
}

// Confirms expiration logic with past and future timestamps
function testIsNotExpired(){
  var future = new Date(Date.now()+1000);
  var past = new Date(Date.now()-1000);
  var r1 = assertTrue('isNotExpired future', isNotExpired(future));
  var r2 = assertTrue('isNotExpired past', !isNotExpired(past));
  return {name:'isNotExpired', pass: r1.pass && r2.pass};
}

// Validates recovery code format and length
function testGenerateRecoveryCode(){
  var code = generateRecoveryCode();
  var r1 = assertTrue('code length 6', typeof code==='string' && code.length===6);
  var r2 = assertTrue('code numeric', /^[0-9]{6}$/.test(code));
  return {name:'generateRecoveryCode', pass: r1.pass && r2.pass};
}

// End-to-end test: login, send recovery code, reset password
function testIntegrationLoginRecovery(){
  ensureDefaultAdmin();
  var html = validateLogin('admin','Admin123!');
  var rLogin = assertTrue('login returns html', typeof html==='string' && html.indexOf('<!DOCTYPE')!==-1);
  var send = processPasswordRecovery('admin');
  var rSend = assertTrue('recovery send', send && send.success===true);
  var recSheet = getOrCreateSheet(spreadsheet, CONFIG.RECOVERY_SHEET_NAME, CONFIG.RECOVERY_HEADERS);
  var rows = recSheet.getDataRange().getValues();
  var code = null;
  for(var i=rows.length-1;i>=1;i--){ if(rows[i][1]==='admin'){ code = rows[i][3]; break; } }
  var reset = resetPassword('admin', code, 'Admin1234!');
  var rReset = assertTrue('reset success', reset && reset.success===true);
  return {name:'integration login/recovery', pass: rLogin.pass && rSend.pass && rReset.pass};
}
