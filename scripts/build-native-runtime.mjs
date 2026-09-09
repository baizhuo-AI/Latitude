// Bundle the existing Agent Host with its own Node runtime into Latitude.app.
// No user credentials, history, node_modules tree or development state is copied.
import { build } from "esbuild";
import { mkdir, copyFile, chmod, readFile } from "node:fs/promises";
import path from "node:path";
const root = path.resolve("src-tauri/resources/agent");
await mkdir(root, {recursive:true});
await build({entryPoints:["services/agent/src/index.ts"],outfile:path.join(root,"agent.mjs"),bundle:true,
  platform:"node",format:"esm",target:"node22",sourcemap:false,
  banner:{js:'import { createRequire as __latitudeCreateRequire } from "node:module"; const require = __latitudeCreateRequire(import.meta.url);'},
  plugins:[{name:"bundled-dsh-attribution",setup(builder){
    builder.onLoad({filter:/dsh-llm\/lib\/index\.js$/},async(args)=>{
      const source=await readFile(args.path,"utf8");
      const manifest=JSON.parse(await readFile(path.resolve(args.path,"../../package.json"),"utf8"));
      const lookup='createRequire(import.meta.url)("../package.json")';
      if(!source.includes(lookup))throw new Error("DSH attribution changed; review native bundling before release.");
      return {contents:source.replace(lookup,JSON.stringify({version:manifest.version})),loader:"js"};
    });
  }}],
});
await copyFile(process.execPath,path.join(root,"node"));
await chmod(path.join(root,"node"),0o755);
console.log("Native Agent runtime bundled without credentials or user data.");
