import { render,screen,waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe,it,expect,vi } from "vitest";
import { ComputerHistoryPanel } from "./ComputerHistoryPanel";
import { createHistoryClient } from "./historyClient";

function fixture(){
  let settings={revision:0,config:{enabled:false,paused:false,nativeEnabled:true,externalEnabled:false,modelProcessing:false,appMode:"exclude",apps:[],siteMode:"exclude",sites:[]},collector:{state:"stopped"}};
  const writes:Record<string,any>[]=[];
  const fetcher=vi.fn(async(url:any,init?:RequestInit)=>{
    const route=new URL(String(url)).pathname;const body=init?.body?JSON.parse(String(init.body)):{};
    if(init?.method==="POST"&&route.endsWith("/settings")){writes.push(body);settings={...settings,...body,revision:settings.revision+1};}
    if(route.endsWith("/clear")){writes.push(body);return Response.json({deleted:1});}
    if(route.endsWith("/query"))return Response.json({items:[],hasMore:false,nextOffset:null});
    if(route.endsWith("/memory"))return Response.json({items:[]});
    if(route.endsWith("/workflow"))return Response.json({items:[]});
    if(route.endsWith("/status"))return Response.json({...settings,external:{available:true},processing:{}});
    return Response.json(settings);
  });
  return {client:createHistoryClient(fetcher),writes};
}
describe("native activity controls",()=>{
  it("requires the disclosure choice and keeps model processing separate",async()=>{
    const user=userEvent.setup();const {client,writes}=fixture();render(<ComputerHistoryPanel client={client} onAsk={()=>{}}/>);
    const toggle=await screen.findByRole("switch",{name:"开启电脑操作行为记录"});
    expect(writes).toHaveLength(0);await user.click(toggle);
    expect(screen.getByRole("group",{name:"开启记录说明"})).toBeVisible();expect(writes).toHaveLength(0);
    await user.click(screen.getByRole("button",{name:"暂不开启"}));expect(writes).toHaveLength(0);
    await user.click(toggle);await user.click(screen.getByRole("button",{name:"开启记录"}));
    await waitFor(()=>expect(writes).toHaveLength(1));expect(writes[0].config).toMatchObject({enabled:true,modelProcessing:false,externalEnabled:false});
    await user.click(await screen.findByRole("button",{name:"暂停记录"}));await waitFor(()=>expect(writes[1].config.paused).toBe(true));
  });
  it("does not clear data until the user confirms the displayed range",async()=>{
    const user=userEvent.setup();const {client,writes}=fixture();render(<ComputerHistoryPanel client={client} onAsk={()=>{}}/>);
    await screen.findByRole("switch");await user.click(screen.getByText("清理记录",{selector:"summary"}));
    await user.click(screen.getByRole("button",{name:"最近 1 小时"}));
    expect(screen.getByRole("alertdialog",{name:"确认清理记录"})).toBeVisible();expect(writes).toHaveLength(0);
    await user.click(screen.getByRole("button",{name:"取消"}));expect(writes).toHaveLength(0);
    await user.click(screen.getByRole("button",{name:"最近 1 小时"}));await user.click(screen.getByRole("button",{name:"确认清理"}));
    await waitFor(()=>expect(writes).toHaveLength(1));expect(writes[0]).toMatchObject({confirm:"删除记录",from:expect.any(String)});
  });
});
