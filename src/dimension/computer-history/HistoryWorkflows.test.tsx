import {render,screen,waitFor} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {describe,it,expect,vi} from "vitest";
import {HistoryWorkflows} from "./HistoryWorkflows";
import type {HistoryClient,HistoryWorkflow} from "./historyClient";

describe("reviewing a history workflow",()=>{
  it("keeps enable unavailable until a successful trial and requires a new trial after editing",async()=>{
    let item:HistoryWorkflow={groupId:"group",version:"v1",title:"整理评审",prompt:"整理活动依据和未确认事项。",cadence:"manual",at:"09:00",weekday:1,state:"draft"};
    const calls:string[]=[];
    const client={workflows:vi.fn(async(input:any)=>{
      const action=input?.action??"list";calls.push(action);
      if(action==="run")item={...item,trialCompleted:true,lastRun:{runId:"trial",status:"completed",text:"有来源的测试草稿。"}};
      if(action==="save")item={...input,version:"v2",trialCompleted:false,lastRun:undefined,state:"draft"};
      return {items:[structuredClone(item)]};
    })} as unknown as HistoryClient;
    const user=userEvent.setup();render(<HistoryWorkflows client={client} prepareGroup={null} onPrepared={()=>{}} onAsk={()=>{}}/>);
    await user.click(await screen.findByRole("button",{name:"编辑与预览"}));
    expect(screen.getByRole("button",{name:"启用这个工作方式"})).toBeDisabled();
    await user.click(screen.getByRole("button",{name:"试用并预览结果"}));
    await screen.findByRole("region",{name:"工作方式结果预览"});
    expect(screen.getByRole("button",{name:"启用这个工作方式"})).toBeEnabled();expect(calls).not.toContain("enable");
    await user.type(screen.getByRole("textbox",{name:"工作方式内容"}),"只看本周。");
    expect(screen.getByRole("button",{name:"启用这个工作方式"})).toBeDisabled();
    await user.click(screen.getByRole("button",{name:"保存草稿"}));
    await waitFor(()=>expect(calls).toContain("save"));
    expect(screen.getByRole("button",{name:"启用这个工作方式"})).toBeDisabled();
  });
});
