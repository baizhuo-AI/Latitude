// Portable Swift policy checks; usable with Command Line Tools without XCTest.
import {mkdtemp,writeFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
const scratch=await mkdtemp(path.join(tmpdir(),"latitude-history-policy-"));
try {
  const source=path.join(scratch,"main.swift");
  await writeFile(source,`
import Foundation
let initial=NativeHistoryConfig()
precondition(!initial.enabled && !initial.externalEnabled && !initial.modelProcessing)
var rules=initial
rules.appMode="include";rules.apps=["com.apple.Preview"]
precondition(rules.allowsApplication("Preview","com.apple.Preview"))
precondition(!rules.allowsApplication("Mail","com.apple.mail"))
rules.siteMode="exclude";rules.sites=["example.com"]
precondition(!rules.allowsSite("sub.example.com"))
precondition(rules.allowsSite("notexample.com"))
precondition(NativeHistoryConfig.isSensitive("AXSecureTextField"))
print("Native history consent, application, domain and secure-field checks passed.")
`);
  const executable=path.join(scratch,"check");
  const build=spawnSync("xcrun",["swiftc","-module-cache-path",path.join(scratch,"cache"),"native/computer-history/Sources/HistoryCore/NativeHistoryConfig.swift",source,"-o",executable],{stdio:"inherit"});
  if(build.status!==0)throw new Error("Native policy check did not compile");
  const check=spawnSync(executable,[],{stdio:"inherit"});
  if(check.status!==0)throw new Error("Native policy check failed");
} finally {await rm(scratch,{recursive:true,force:true});}
