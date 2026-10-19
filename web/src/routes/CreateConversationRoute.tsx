import { ArrowLeft, MessageCircle } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "@tanstack/react-router";

import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useDemoRuntime } from "@/demo/context";

export function CreateConversationRoute() {
  const runtime = useDemoRuntime();
  const navigate = useNavigate();
  const [projectId, setProjectId] = useState("");
  const [message, setMessage] = useState("");

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!runtime.canWrite || !message.trim()) return;
    const id = runtime.createConversation({ message, projectId: projectId || undefined });
    if (!id) return;
    void navigate({ to: "/conversations/$conversationId", params: { conversationId: id } });
  };

  return (
    <section className="page-section create-page"><Link to="/conversations" className="back-link"><ArrowLeft size={15} aria-hidden="true" />返回全部对话</Link><div className="page-heading"><div><span className="eyebrow">SIMULATED CONVERSATION</span><h1>新建对话</h1><p>先开始讨论；不必先建立任务或选择项目。发送动作只属于当前 Demo。</p></div><span className="demo-write-chip"><MessageCircle size={14} aria-hidden="true" />mock-only</span></div><form className="form-panel" onSubmit={submit}><label className="form-field"><span>项目（可选）</span><Select value={projectId || "__none__"} onValueChange={(value) => setProjectId(value === "__none__" ? "" : value)} disabled={!runtime.canWrite}><SelectTrigger aria-label="项目（可选）"><SelectValue /></SelectTrigger><SelectContent><SelectGroup><SelectItem value="__none__">暂不选择项目</SelectItem>{runtime.fixtures.projects.map((project) => <SelectItem value={project.id} key={project.id}>{project.name}</SelectItem>)}</SelectGroup></SelectContent></Select></label><label className="form-field"><span>想讨论什么</span><Textarea required rows={6} value={message} onChange={(event) => setMessage(event.target.value)} placeholder="说说你的问题或想法…" disabled={!runtime.canWrite} /></label><div className="form-actions"><Button type="submit" variant="default" className="button button-primary" disabled={!runtime.canWrite || !message.trim()}>开始模拟对话</Button><Button asChild variant="secondary" className="button button-secondary"><Link to="/conversations">取消</Link></Button></div></form></section>
  );
}
