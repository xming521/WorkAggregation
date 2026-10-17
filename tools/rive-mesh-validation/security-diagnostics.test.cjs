'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {assertSafeArguments,collectSecurityDiagnostics,cleanupAndSave}=require('./security-diagnostics.cjs');
const safe=['/opt/google/chrome/chrome','--headless','--remote-debugging-pipe'];
test('optional CDP failure returns verified actual arguments without throwing',async()=>{
 const result=await collectSecurityDiagnostics({send:async()=>{throw Error('enable-automation not set');}},safe);
 assert.deepEqual(result.actualArguments,safe);assert.equal(result.diagnosticWarnings.length,1);
});
test('CDP success preserves independently verified arguments',async()=>{
 const result=await collectSecurityDiagnostics({send:async()=>({arguments:safe})},safe);assert.deepEqual(result.cdpArguments,safe);
});
test('forbidden actual process argument blocks before CDP even if CDP would fail',async()=>{
 let called=false;await assert.rejects(collectSecurityDiagnostics({send:async()=>{called=true;throw Error('optional');}},[...safe,'--no-sandbox']),{code:'UNSAFE_BROWSER_ARGUMENT'});assert.equal(called,false);
});
test('forbidden CDP argument is never downgraded to a warning',async()=>{
 await assert.rejects(collectSecurityDiagnostics({send:async()=>({arguments:[...safe,'--enable-unsafe-swiftshader']})},safe),{code:'UNSAFE_BROWSER_ARGUMENT'});
});
test('missing actual argv fails closed',()=>{assert.throws(()=>assertSafeArguments([]),{code:'SECURITY_EVIDENCE_UNAVAILABLE'});});
test('later rendering exceptions remain exceptions',async()=>{
 await assert.rejects((async()=>{await collectSecurityDiagnostics({send:async()=>{throw Error('optional');}},safe);throw Error('actual render failure');})(),/actual render failure/);
});

test('cleanup failures cannot skip later cleanup or final safety-report save',async()=>{
 const seen=[];const report={outcome:'security_validation_failure'};
 const errors=await cleanupAndSave([
  ['browser',async()=>{seen.push('browser');throw Error('closed');}],
  ['browserServer',async()=>{seen.push('browserServer');throw Error('already closed');}],
  ['httpServer',async()=>seen.push('httpServer')]
 ],async errors=>{seen.push('save');report.cleanupErrors=errors;});
 assert.deepEqual(seen,['browser','browserServer','httpServer','save']);assert.equal(errors.length,2);assert.equal(report.outcome,'security_validation_failure');
});
