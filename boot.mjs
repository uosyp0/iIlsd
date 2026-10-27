import {readFile, writeFile, mkdir, stat} from 'node:fs/promises';
import {createHash, randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {resolve, dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createServer as createNetServer} from 'node:net';

function isPortAvailable(port) {
  return new Promise((resolve) => {
    const s = createNetServer()
      .once('error', () => resolve(false))
      .once('listening', () => s.once('close', () => resolve(true)).close())
      .listen(Number(port), '0.0.0.0');
  });
}

async function detectActiveTunnel() {
  try {
    const res = await fetch('http://127.0.0.1:4040/api/tunnels', { signal: AbortSignal.timeout(600) });
    if (res.ok) {
      const data = await res.json();
      const t = data.tunnels?.find(item => item.public_url?.startsWith('https://'));
      if (t?.public_url) return t.public_url;
    }
  } catch {}
  return null;
}

const root=fileURLToPath(new URL('.',import.meta.url));
export const runtime=join(root,'.runtime');
const secretNames=['DELIVERY_ENCRYPTION_KEY','INTERNAL_API_SECRET','CRON_SECRET'];
export async function unpack() {
  const pack=JSON.parse(await readFile(join(root,'app.pack.json'),'utf8'));
  if(pack.version!==1 || !pack.files)throw Error('Invalid application bundle');
  const entries=Object.entries(pack.files);
  for(const [name,entry] of entries) {
    if(!name || name.includes('\\') || name.split('/').some(p=>!p || p==='..' || p==='.') || resolve(runtime,name)===runtime || !resolve(runtime,name).startsWith(runtime+'/'))throw Error('Invalid bundled path');
    if(typeof entry.content!=='string' || createHash('sha256').update(entry.content).digest('hex')!==entry.sha256)throw Error('Damaged application bundle: '+name);
  }
  for(const [name,entry] of entries) {
    const target=join(runtime,name);
    const existing=await readFile(target,'utf8').catch(e=>{if(e.code==='ENOENT')return null;throw e;});
    if(existing!==null && existing!==entry.content)throw Error('Edited runtime file: '+name+'. Save changes with node boot.mjs pack.');
  }
  for(const [name,entry] of entries) {
    const target=join(runtime,name);await mkdir(dirname(target),{recursive:true});
    try{await writeFile(target,entry.content,{flag:'wx'});}catch(e){if(e.code!=='EEXIST')throw e;}
  }
  // Local development creates working files; keep them out of Git and Docker.
  try{await writeFile(join(root,'.gitignore'),'.runtime/\nconnection/\n.env*\n*.sqlite*\nrailway-variables.env\n',{flag:'wx'});}catch(e){if(e.code!=='EEXIST')throw e;}
  return entries.length;
}
export async function persistentEnvironment(source=process.env) {
  const env={...source};
  env.COMMERCE_MODE ||= "ecosystem";
  env.BOT_BRIDGE_URL ||= "http://127.0.0.1:8099";
  const railway=Boolean(env.RAILWAY_ENVIRONMENT_ID || env.RAILWAY_PUBLIC_DOMAIN);
  const folder=env.RAILWAY_VOLUME_MOUNT_PATH || env.DATA_DIR || (railway?null:join(runtime,'.data'));
  if(!folder || !folder.startsWith('/'))throw Error('Attach one Railway Volume at /data. No database URL is needed.');
  env.DATA_DIR=folder;
  await mkdir(folder,{recursive:true});
  const path=join(folder,'miniapp-secrets.json');
  let saved;
  try{saved=JSON.parse(await readFile(path,'utf8'));}
  catch(e){if(e.code!=='ENOENT')throw Error('Cannot read saved secrets. Restore miniapp-secrets.json; do not delete or regenerate it.');}
  if(saved) {
    if(saved.version!==1 || !saved.secrets || secretNames.some(name=>typeof saved.secrets[name]!=='string'))throw Error('Invalid saved secrets. Restore the original file.');
    if(env.DELIVERY_ENCRYPTION_KEY && env.DELIVERY_ENCRYPTION_KEY!==saved.secrets.DELIVERY_ENCRYPTION_KEY)throw Error('DELIVERY_ENCRYPTION_KEY differs from the saved key. Restore the existing key before starting.');
    for(const name of secretNames)env[name] ||= saved.secrets[name];
  } else {
    let db=join(folder,'legit.sqlite');
    if(env.DATABASE_URL?.startsWith('file:'))db=fileURLToPath(env.DATABASE_URL);
    const existing=await stat(db).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
    if(existing?.size && !env.DELIVERY_ENCRYPTION_KEY)throw Error('Existing database: supply its original DELIVERY_ENCRYPTION_KEY. Automatic key replacement is refused.');
    env.DELIVERY_ENCRYPTION_KEY ||= randomBytes(32).toString('base64');
    env.INTERNAL_API_SECRET ||= randomBytes(32).toString('hex');
    env.CRON_SECRET ||= randomBytes(32).toString('hex');
    if(!/^[A-Za-z0-9+/]{43}=$/.test(env.DELIVERY_ENCRYPTION_KEY) || ['INTERNAL_API_SECRET','CRON_SECRET'].some(name=>env[name].length<32))throw Error('Invalid internal secret configuration.');
    const secrets=Object.fromEntries(secretNames.map(name=>[name,env[name]]));
    try{await writeFile(path,JSON.stringify({version:1,secrets})+'\n',{flag:'wx',mode:0o600});}
    catch(e){if(e.code==='EEXIST')return persistentEnvironment(source);throw e;}
  }
  if(!/^[A-Za-z0-9+/]{43}=$/.test(env.DELIVERY_ENCRYPTION_KEY) || ['INTERNAL_API_SECRET','CRON_SECRET'].some(name=>env[name].length<32))throw Error('Invalid internal secret configuration.');
  if(railway){env.AUTO_MIGRATE='true';env.START_COMMERCE_WORKER='true';}
  return env;
}
async function run(args,env=process.env) {
  const child=spawn(args[0],args.slice(1),{cwd:runtime,env,stdio:'inherit'});
  const term=()=>child.kill('SIGTERM');const interrupt=()=>child.kill('SIGINT');
  process.once('SIGTERM',term);process.once('SIGINT',interrupt);
  try {return await new Promise((done,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>done(code??(signal?1:0)));});}
  finally{process.off('SIGTERM',term);process.off('SIGINT',interrupt);}
}
async function main() {
  const command=process.argv[2] || 'start';
  if(command==='connect') {
    const option=name=>process.argv.find(value=>value.startsWith('--'+name+'='))?.slice(name.length+3);
    const origin=name=>{const raw=option(name);let url;try{url=new URL(raw);}catch{throw Error('Pass --'+name+'=https://your-domain');}if(url.protocol!=='https:' || url.username || url.password || url.pathname!=='/' || url.search || url.hash)throw Error('Use a public HTTPS origin for '+name);return url.origin;};
    const miniapp=origin('miniapp'),bot=origin('bot');
    if(miniapp===bot)throw Error('Use the separate public domain of each service.');
    const secrets={BOT_BRIDGE_SECRET:process.env.BOT_BRIDGE_SECRET || randomBytes(32).toString('hex')};
    if(Object.values(secrets).some(value=>!/^[A-Za-z0-9_-]{32,256}$/.test(value)))throw Error('Connection secrets must contain 32–256 URL-safe characters.');
    const ignore=join(root,'.gitignore');
    const ignored=await readFile(ignore,'utf8').catch(error=>{if(error.code==='ENOENT')return '';throw error;});
    if(!ignored.split(/\r?\n/).some(line=>line==='connection/' || line==='/connection/'))await writeFile(ignore,'\nconnection/\n',{flag:'a'});
    const folder=join(root,'connection');await mkdir(folder,{recursive:true,mode:0o700});
    const common=Object.entries(secrets).map(([key,value])=>key+'='+value).join('\n');
    const targets=[['miniapp-connection.env','COMMERCE_MODE=ecosystem\nBOT_BRIDGE_URL='+bot+'\n'+common+'\n'],['bot-connection.env','MINIAPP_BASE_URL='+miniapp+'\n'+common+'\n']];
    for(const [name] of targets){const exists=await stat(join(folder,name)).catch(error=>{if(error.code==='ENOENT')return null;throw error;});if(exists)throw Error('Existing connection files kept. Reuse them; do not generate different secrets.');}
    for(const [name,content] of targets)await writeFile(join(folder,name),content,{flag:'wx',mode:0o600});
    console.log('Created connection/miniapp-connection.env and connection/bot-connection.env. Add each to the matching service Variables; keep BOT_TOKEN identical. Secrets are not printed.');return;
  }
  if(command==='pack') {
    const path=join(root,'app.pack.json');
    const pack=JSON.parse(await readFile(path,'utf8'));
    for(const [name,entry] of Object.entries(pack.files)) {
      entry.content=await readFile(join(runtime,name),'utf8');entry.sha256=createHash('sha256').update(entry.content).digest('hex');
    }
    await writeFile(path,JSON.stringify(pack,null,2)+'\n');
    console.log('Application sources saved. For changes to generated routes/tests, run npm run source:pack in .runtime first.');
    return;
  }
  if(command==='unpack'){console.log('Application sources ready: '+await unpack()+' bundled files.');return;}
  // Runtime already exists in Docker; avoid rewriting source files on every restart.
  await stat(join(runtime,'package.json')).catch(async e=>{if(e.code==='ENOENT')await unpack();else throw e;});
  if(['start','dev'].includes(command) && (process.env.COMMERCE_MODE||'ecosystem')==='ecosystem') {
    let code='configured';let url;
    try{url=new URL(process.env.BOT_BRIDGE_URL || 'http://127.0.0.1:8099');}catch{code=process.env.BOT_BRIDGE_URL?'bridge_url_invalid':'bridge_url_missing';}
    if(url && (url.protocol!=='https:' && !(url.protocol==='http:' && (url.hostname==='127.0.0.1'||url.hostname==='localhost')) ||url.username||url.password||url.search||url.hash))code='bridge_url_invalid';
    if(code==='configured' && !/^[A-Za-z0-9_-]{32,256}$/.test(process.env.BOT_BRIDGE_SECRET||''))code='bridge_secret_invalid';
    if(url && process.env.RAILWAY_PUBLIC_DOMAIN && url.host===process.env.RAILWAY_PUBLIC_DOMAIN)code='bridge_self_reference';
    console.info(JSON.stringify({event:'bridge.configuration',status:code,hint:'Open /admin/operations for authenticated connection diagnostics. No provider connection has been verified by this startup message.'}));
  }
  if(command==='install')process.exitCode=await run(['npm','ci']);
  else if(command==='build')process.exitCode=await run(['npm','run','build']);
  else if(command==='dev') {
    const env = await persistentEnvironment();
    const detected = await detectActiveTunnel();
    if (detected && !env.NEXT_PUBLIC_SITE_URL) {
      env.NEXT_PUBLIC_SITE_URL = detected;
      console.log(`[boot] Active tunnel detected: ${detected} -> configuring origin.`);
    }
    process.exitCode=await run(['npm','run','dev'], env);
  }
  else if(command==='start') {
    const env = await persistentEnvironment();
    const cliPort = process.argv.slice(3).find(a => /^\d+$/.test(a) || a.startsWith('--port='))?.replace('--port=', '');
    if (cliPort) {
      env.PORT = cliPort;
    } else if (!process.env.PORT) {
      const p3000Ok = await isPortAvailable(3000);
      if (!p3000Ok) {
        env.PORT = "3456";
        console.log('[boot] Port 3000 is occupied. Auto-selected port 3456.');
      } else {
        env.PORT = "3000";
      }
    }
    const detected = await detectActiveTunnel();
    if (detected && !env.NEXT_PUBLIC_SITE_URL) {
      env.NEXT_PUBLIC_SITE_URL = detected;
      console.log(`[boot] Active tunnel detected: ${detected} -> configuring origin.`);
    }
    env.BOT_BRIDGE_URL ||= "http://127.0.0.1:8099";
    process.exitCode = await run([process.execPath,'scripts/start.mjs'], env);
  }
  else if(command==='run')process.exitCode=await run(['npm','run',...process.argv.slice(3)],await persistentEnvironment());
  else throw Error('Use node boot.mjs unpack|install|build|dev|start|run <npm script>|pack');
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(error=>{
  console.error('[boot] '+(error.code?'File or process operation failed. Check Volume permissions and configuration.':error.message));process.exitCode=1;
});
