// Synthetic fetch implementation shared by the static preview and its regression test.
export function archiveFixtureScript(response: string, preferences: string, profile: string): string {
  return `const fixture=${response};window.demoArchiveCalls=[];window.fetch=async(input,options)=>{
    const path=String(input);
    if(path.includes("api/conversation-archive")&&options?.method==="POST"){
      const {task_id:taskId,action="archive"}=JSON.parse(options.body);
      const task=fixture.view.tasks.find(t=>t.id===taskId);
      window.demoArchiveCalls.push(taskId);
      task.conversation_resource={
        ...task.conversation_resource,
        id:task.conversation_resource?.id??("fixture-"+taskId),
        kind:"conversation",target:task.thread_id,
        status:action==="unarchive"?"active":"closed",
        archive_policy:action==="unarchive"?"manual":"auto",
        evidence_ref:"fixture:"+action+":"+taskId,error:null
      };
      fixture.revision++;
      return new Response(JSON.stringify(task.conversation_resource));
    }
    return new Response(path.includes("api/preferences")?${JSON.stringify(preferences)}:path.includes("api/execution-profile")?${JSON.stringify(profile)}:JSON.stringify(fixture),{headers:{"Content-Type":"application/json"}});
  };`;
}
