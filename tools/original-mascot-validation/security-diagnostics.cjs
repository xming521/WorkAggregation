'use strict';
const forbidden=/^--(?:no-sandbox|disable-setuid-sandbox|disable-gpu-sandbox|enable-unsafe-swiftshader|disable-web-security|ignore-certificate-errors|ignore-gpu-blocklist)(?:=|$)/;
function assertSafeArguments(args){
  if(!Array.isArray(args)||!args.length||args.some(a=>typeof a!=='string'))throw Object.assign(Error('Actual browser process arguments unavailable'),{code:'SECURITY_EVIDENCE_UNAVAILABLE'});
  const rejected=args.filter(a=>forbidden.test(a));
  if(rejected.length)throw Object.assign(Error('Forbidden browser arguments: '+rejected.join(', ')),{code:'UNSAFE_BROWSER_ARGUMENT'});
  return args.slice();
}
async function collectSecurityDiagnostics(cdp,spawnArguments){
  // BrowserServer.process().spawnargs is Node's actual spawned executable/argv,
  // not reconstructed requested launch options. Validate before optional CDP.
  const actualArguments=assertSafeArguments(spawnArguments);
  const result={actualArguments,argumentSource:'BrowserServer.process().spawnargs',diagnosticWarnings:[]};
  let cdpArgs;
  try{cdpArgs=(await cdp.send('Browser.getBrowserCommandLine')).arguments;}
  catch(e){result.diagnosticWarnings.push({method:'Browser.getBrowserCommandLine',error:String(e)});}
  // Never catch or downgrade a security check failure.
  if(cdpArgs!==undefined)result.cdpArguments=assertSafeArguments(cdpArgs);
  return result;
}
async function cleanupAndSave(steps,saveReport,timeoutMs=5000){
  const errors=[];
  for(const [name,close,onTimeout] of steps){
    let timer;
    try{await Promise.race([Promise.resolve().then(close),new Promise((_,reject)=>{timer=setTimeout(()=>{try{onTimeout?.();}catch{} reject(Error('Cleanup timed out'));},timeoutMs);})]);}
    catch(e){errors.push({name,error:String(e)});}
    finally{clearTimeout(timer);}
  }
  await saveReport(errors);
  return errors;
}
module.exports={assertSafeArguments,collectSecurityDiagnostics,cleanupAndSave};
