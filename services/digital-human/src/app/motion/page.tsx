"use client";
import React, {useEffect, useRef, useState} from "react";
import dynamic from "next/dynamic";
import {Upload, Sparkles, Film, Download, Plus, Trash2, Check, Loader2, RotateCcw, Save, FileText, History, X} from "lucide-react";
import {uploadMediaFile} from "@/lib/client-media-upload";
import {type MotionProject, type MotionCaption, type MotionScene, type MotionEdit, type MotionTaskSource, DEFAULT_MOTION_CROP, parseSrt, validateMotionEdit} from "@/lib/motion/contract";
import MotionLibrary from "@/components/MotionLibrary";
import type {EffectTemplate, LibraryEffect} from "@/lib/motion-library/contract";
import MotionCropEditor from "@/components/MotionCropEditor";
import "./motion.css";
const MotionPreview = dynamic(() => import("@/components/MotionPreview"), {ssr: false});
const empty: MotionEdit = {title: "", subtitle: "", fit: "cover", crop: DEFAULT_MOTION_CROP, captions: [], scenes: []};
const busyStatus = (p: MotionProject | null) => p?.status === "analyzing" || p?.status === "rendering";
const statusLabel = {analyzing: "整理中", ready: "待生成", rendering: "生成中", completed: "已完成", failed: "需重试"};
const timeLabel = (seconds: number) => `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60).toString().padStart(2, "0")}`;
async function api(url: string, init?: RequestInit) {
  const response = await fetch(url, {...init, cache: "no-store"});
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "操作失败，请重试");
  return data;
}
export default function MotionPage() {
  const [showHistory,setShowHistory]=useState(false);
  const [effectTemplate,setEffectTemplate]=useState<EffectTemplate>();
  const [effectName,setEffectName]=useState("");
  const [projects, setProjects] = useState<MotionProject[]>([]);
  const [project, setProject] = useState<MotionProject | null>(null);
  const [edit, setEdit] = useState<MotionEdit>(empty);
  const [file, setFile] = useState<File | null>(null);
  const [taskVideo, setTaskVideo] = useState<MotionTaskSource | null>(null);
  const [localUrl, setLocalUrl] = useState("");
  const [sourceDuration, setSourceDuration] = useState(0);
  const [uploadKey, setUploadKey] = useState("");
  const [pending, setPending] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [dirty, setDirty] = useState(false);
  const [tab, setTab] = useState<"scenes" | "captions">("scenes");
  const fileInput = useRef<HTMLInputElement>(null), srtInput = useRef<HTMLInputElement>(null);
  const errorAlert = useRef<HTMLDivElement>(null);
  const busy = pending || busyStatus(project);
  const refreshList = async () => {try {setProjects((await api("/api/motion")).projects);} catch (err) {setError((err as Error).message);}};
  useEffect(() => {void refreshList();}, []);
  useEffect(() => {
    const taskId = new URLSearchParams(window.location.search).get("fromTask");
    if (!taskId) return;
    let stopped = false;
    setPending(true); setNotice("正在载入制作台成片");
    void api(`/api/motion/from-task/${encodeURIComponent(taskId)}`).then(data => {
      if (stopped) return;
      setTaskVideo(data.video); setSourceDuration(data.video.duration);
      setNotice("已带入制作台成片，可调整裁剪并填写标题后开始整理");
    }).catch(err => {if (!stopped) {setError(err.message); setNotice("");}})
      .finally(() => {if (!stopped) setPending(false);});
    return () => {stopped = true;};
  }, []);
  useEffect(() => {
    if (error || project?.error) {
      errorAlert.current?.scrollIntoView({block: "center", behavior: "smooth"});
      errorAlert.current?.focus({preventScroll: true});
    }
  }, [error, project?.error]);
  useEffect(() => {if (!file) {setLocalUrl(""); return;} const url = URL.createObjectURL(file); setLocalUrl(url); return () => URL.revokeObjectURL(url);}, [file]);
  useEffect(() => {
    if (!project || !busyStatus(project)) return;
    let stopped = false;
    const timer = setInterval(async () => {
      try {
        const next: MotionProject = (await api(`/api/motion/${project.id}`)).project;
        if (stopped) return;
        setProject(next); setEdit(next); setProjects(all => all.map(p => p.id === next.id ? next : p));
        if (!busyStatus(next)) void refreshList();
      } catch (err) {if (!stopped) setError((err as Error).message);}
    }, 2500);
    return () => {stopped = true; clearInterval(timer);};
  }, [project?.id, project?.status]);
  function change(update: Partial<MotionEdit>) {setEdit(current => ({...current, ...update})); setDirty(true); setNotice("");}
  function clearTaskVideo() {
    setTaskVideo(null);
    const url = new URL(window.location.href); url.searchParams.delete("fromTask");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }
  function select(p: MotionProject) {clearTaskVideo(); setProject(p); setEdit(p); setFile(null); setUploadKey(""); setDirty(false); setError(""); setNotice("");}
  function newProject() {clearTaskVideo(); setProject(null); setEdit(empty); setFile(null); setUploadKey(""); setDirty(false); setSourceDuration(0); setError(""); setNotice("");}
  function chooseFile(next?: File) {
    if (!next) return;
    if (next.size > 500 * 1024 * 1024 || !/\.(mp4|mov|m4v)$/i.test(next.name)) {setError("请上传不超过 500 MB 的 MP4 或 MOV 视频"); return;}
    clearTaskVideo(); setFile(next); setUploadKey(""); setSourceDuration(0); setError("");
    change({crop: {...DEFAULT_MOTION_CROP}});
  }
  async function create() {
    if (!file && !taskVideo) {setError("请先上传最终剪辑版"); return;}
    setPending(true); setError("");
    try {
      const validated = validateMotionEdit(edit, sourceDuration || 600);
      let key = uploadKey;
      if (!key) {
        if (taskVideo) {
          setNotice("正在转入制作台成片");
          key = (await api(`/api/motion/from-task/${encodeURIComponent(taskVideo.taskId)}`, {method: "POST"})).uploadKey;
        } else if (file) {
          setNotice("正在上传最终剪辑版");
          key = (await uploadMediaFile(file, file.name, "videos", setUploadProgress)).uploadKey;
        }
        setUploadKey(key);
      }
      setNotice("视频已上传，正在创建整理任务");
      const data = await api("/api/motion", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({...validated, uploadKey: key, name: taskVideo?.name || file!.name})});
      clearTaskVideo(); setProject(data.project); setEdit(data.project); setDirty(false); setNotice(""); void refreshList();
    } catch (err) {setError((err as Error).message); setNotice("");} finally {setPending(false);}
  }
  async function act(action: "save" | "analyze" | "render" | "prepare", currentEdit = edit) {
    if (!project) return;
    setPending(true); setError(""); setNotice("");
    try {
      const validated = validateMotionEdit(currentEdit, project.duration, action === "render");
      if (action === "save" && effectTemplate?.semantics?.required && validated.scenes.length) action = "prepare";
      const data = await api(`/api/motion/${project.id}`, {method: "PATCH", headers: {"Content-Type": "application/json"}, body: JSON.stringify({...validated, action})});
      setProject(data.project); setEdit(data.project); setDirty(false); if (action === "save") setNotice("修改已保存"); void refreshList();
    } catch (err) {setError((err as Error).message);} finally {setPending(false);}
  }
  async function importSrt(file?: File) {
    if (!file) return;
    try {if (file.size > 300_000) throw new Error("SRT 文件过大"); const captions = parseSrt(await file.text()); change({captions}); setNotice(`已导入 ${captions.length} 条字幕`); setError("");} catch (err) {setError((err as Error).message);}
  }
  useEffect(()=>{
    let stopped=false;setEffectTemplate(undefined);setEffectName("");
    if(edit.effect) void api(`/api/motion-library/${edit.effect.id}?revision=${edit.effect.revision}`).then(data=>{if(!stopped){setEffectTemplate(data.effect.template);setEffectName(data.effect.name);}}).catch(err=>{if(!stopped)setError(err.message);});
    return()=>{stopped=true;};
  },[edit.effect?.id,edit.effect?.revision]);
  function applyEffect(effect:LibraryEffect){
    const next={...edit,effect:{id:effect.id,revision:effect.revision},scenes:edit.scenes.map(({visual:_visual,...s})=>s)};
    change(next);
    if(effect.semantics?.required&&project&&next.scenes.length)void act("prepare",next);
    else setNotice(effect.semantics?.required?`已应用「${effect.name}」，整理口播时会自动编排图解`:`已应用「${effect.name}」，生成成片时会使用当前总结文字`);
    document.getElementById("motion-preview")?.scrollIntoView({behavior:"smooth",block:"center"});
  }
  const duration = project?.duration || sourceDuration || 10;
  const preview = {...edit, effectTemplate, title: edit.title || "什么是超级员工？", subtitle: edit.subtitle || "给普通人配一个超级外挂", duration, sourceUrl: localUrl || project?.sourceUrl || taskVideo?.sourceUrl || ""};
  const scenes = edit.scenes;
  const diagram = edit.effect?.id === 'builtin_green_diagram' && edit.effect.revision === 1;
  const updateCaption = (index: number, changes: Partial<MotionCaption>) => change({captions: edit.captions.map((c, i) => i === index ? {...c, ...changes} : c)});
  const feedback = <>{(error || project?.error) && <div ref={errorAlert} tabIndex={-1} role="alert" className="motion-alert">{error || project?.error}</div>}{notice && <div role="status" className="motion-notice">{notice}{pending && !project && notice === "正在上传最终剪辑版" ? ` ${uploadProgress}%` : ""}</div>}</>;
  return <main className="motion-workspace">
    <div className="motion-heading"><div><p className="motion-eyebrow">最后一步，让表达更清楚</p><h1>数字人动效</h1><p>上传粗剪后的最终版本，为口播配上标题、字幕和随内容变化的总结动效。</p></div><button className="motion-button secondary" onClick={newProject} disabled={busy}><Plus size={16}/>新建动效</button></div>
    <div className="motion-toolbar"><div className="motion-steps">{["上传最终剪辑版", "校对字幕与总结", "生成动效成片"].map((label, i) => <div key={label} className={(project ? (project.status === "completed" ? 2 : 1) : 0) >= i ? "active" : ""}><span>{i+1}</span>{label}</div>)}</div><button className="motion-button secondary motion-history-toggle" aria-expanded={showHistory} aria-controls="motion-history" onClick={()=>setShowHistory(!showHistory)}><History size={16}/>历史记录</button>
      {showHistory&&<section id="motion-history" className="motion-history-popover" role="dialog" aria-label="动效历史记录" onKeyDown={e=>{if(e.key==="Escape")setShowHistory(false);}}><div><h2>最近动效任务</h2><button aria-label="关闭历史记录" className="motion-text-button" onClick={()=>setShowHistory(false)}><X size={18}/></button></div><div className="motion-history-list">{projects.map(p=><button key={p.id} disabled={busy} className={project?.id===p.id?"selected":""} onClick={()=>{select(p);setShowHistory(false);}}><Film size={18}/><span><strong>{p.title}</strong><small>{p.name} · {new Date(p.createdAt).toLocaleDateString("zh-CN")}</small></span><em>{statusLabel[p.status]}</em></button>)}{!projects.length&&<p className="motion-help">暂无动效任务，完成上传后会保存在这里。</p>}</div></section>}
    </div>
    {project && feedback}
    <div className="motion-grid"><section className="motion-editor">
      <div className="motion-panel"><div className="motion-section-title"><span>01</span><h2>最终剪辑版</h2></div>
        {!project ? <><input ref={fileInput} type="file" accept="video/mp4,video/quicktime,.mp4,.mov,.m4v" hidden onChange={e => {chooseFile(e.target.files?.[0]); e.target.value = "";}}/>
          <button className="motion-upload" disabled={busy} onClick={() => fileInput.current?.click()} onDragOver={e => e.preventDefault()} onDrop={e => {e.preventDefault(); if (!busy) chooseFile(e.dataTransfer.files[0]);}}>
            {file || taskVideo ? <Film size={28}/> : <Upload size={28}/>}<strong>{file?.name || taskVideo?.name || "点击或拖入剪好的数字人视频"}</strong><span>{taskVideo ? "来自制作台的数字人成片 · 点击可更换" : file ? `${(file.size / 1024 / 1024).toFixed(1)} MB · 点击可更换` : "MP4 / MOV · 最长 10 分钟 · 最大 500 MB"}</span>
          </button>{(localUrl || taskVideo?.sourceUrl) && <video src={localUrl || taskVideo?.sourceUrl} preload="metadata" hidden onLoadedMetadata={e => {const d = e.currentTarget.duration; setSourceDuration(d); if (d > 600) setError("视频超过 10 分钟，请缩短后上传");}}/>}</> : <div className="motion-source"><Film size={22}/><div><strong>{project.name}</strong><span>{timeLabel(project.duration)} · {project.width || "—"} × {project.height || "—"} · 保留原声</span></div><span className="motion-status">{statusLabel[project.status]}</span></div>}
        <div className="motion-fit"><label htmlFor="motion-fit">人物画面</label><select id="motion-fit" value={edit.fit} disabled={busy} onChange={e => change({fit: e.target.value as MotionEdit["fit"]})}><option value="cover">手动裁剪（铺满中间区域）</option><option value="contain">保留完整画面（可能留边）</option></select></div>
        {preview.sourceUrl && edit.fit === "cover" && <MotionCropEditor key={preview.sourceUrl} sourceUrl={preview.sourceUrl} crop={edit.crop ?? DEFAULT_MOTION_CROP} disabled={Boolean(busy)} onChange={crop => change({crop})}/>}
      </div>
      <div className="motion-panel"><div className="motion-section-title"><span>02</span><h2>顶部固定标题</h2><small>贯穿整条视频</small></div>
        <label className="motion-field"><span><i className="yellow"/>第一行 · 黄色特效字 <small>{edit.title.length}/22</small></span><input maxLength={22} value={edit.title} disabled={busy} placeholder="例如：什么是超级员工？" onChange={e => change({title: e.target.value})}/></label>
        <label className="motion-field"><span><i/>第二行 · 白色描边字 <small>{edit.subtitle.length}/26</small></span><input maxLength={26} value={edit.subtitle} disabled={busy} placeholder="例如：给普通人配一个超级外挂" onChange={e => change({subtitle: e.target.value})}/></label>
      </div>
      <div className="motion-panel"><div className="motion-effect-choice"><span>底部动效：{edit.effect ? effectName || "正在加载…" : "默认绿金总结"}</span><div>{edit.effect&&<button className="motion-text-button" disabled={busy} onClick={()=>change({effect:undefined})}>恢复默认</button>}<a href="#motion-library" className="motion-text-button">从动效库选择</a></div></div><div className="motion-section-title"><span>03</span><h2>字幕与底部总结</h2></div>
        <input ref={srtInput} type="file" accept=".srt" hidden onChange={e => {void importSrt(e.target.files?.[0]); e.target.value = "";}}/>
        {!project ? <div className="motion-analysis-intro"><FileText size={24}/><p>自动识别口播字幕，把相邻一两句话整理为一张总结卡片，按原视频时间切换。</p><button className="motion-text-button" disabled={busy} onClick={() => srtInput.current?.click()}>已有字幕？导入 SRT{edit.captions.length ? `（已导入 ${edit.captions.length} 条）` : ""}</button>{feedback}<button className="motion-button primary" disabled={busy || (!file && !taskVideo) || !edit.title.trim() || !edit.subtitle.trim() || sourceDuration > 600} onClick={create}>{busy ? <Loader2 className="motion-spin" size={18}/> : <Sparkles size={18}/>} {pending ? "正在准备并整理…" : taskVideo ? "开始自动整理" : "上传并自动整理"}</button></div> : <>
          {busyStatus(project) && <div className="motion-progress" role="status"><div><Loader2 className="motion-spin" size={17}/>{project.message}<strong>{project.progress}%</strong></div><progress value={project.progress} max={100}/><small>任务在后台继续，刷新页面后可从最近任务恢复。</small></div>}
          <div className="motion-tabs"><button className={tab === "scenes" ? "selected" : ""} onClick={() => setTab("scenes")}>底部总结 <span>{scenes.length}</span></button><button className={tab === "captions" ? "selected" : ""} onClick={() => setTab("captions")}>口播字幕 <span>{edit.captions.length}</span></button><button className="motion-import" disabled={busy} onClick={() => srtInput.current?.click()}>导入 SRT</button></div>
          <p className="motion-help">{tab === "scenes" ? diagram ? "每段口播对应一张图解，可选流程、分支、汇总或公式。三个文案依次对应图中节点，使用简短概念更清晰；高亮词需出现在第二或第三个节点中。" : "每张卡片对应一段口播，最多一个短标题、两行总结。高亮词需出现在正文里。" : "在这里校对完整原话和时间。成片自动去掉标点，优先按停顿和完整词语显示短句，不按固定字数截断；已有字幕的源视频建议先导出无字幕版本，避免叠字。"}</p>
          <div className="motion-timeline">{tab === "scenes" ? scenes.map((s, i) => <div className="motion-scene" key={i}><div className="motion-time"><strong>片段 {String(i+1).padStart(2, "0")}</strong><label>开始 <input aria-label={`总结 ${i+1} 开始秒`} type="number" min={0} step={0.1} value={s.start} disabled={busy} onChange={e => change({scenes: scenes.map((item, j) => j === i ? {...item, start: Number(e.target.value)} : item)})}/></label><span>—</span><label>结束 <input aria-label={`总结 ${i+1} 结束秒`} type="number" min={0} step={0.1} value={s.end} disabled={busy} onChange={e => change({scenes: scenes.map((item, j) => j === i ? {...item, end: Number(e.target.value)} : item)})}/></label><button aria-label={`删除总结 ${i+1}`} disabled={busy} onClick={() => change({scenes: scenes.filter((_, j) => j !== i)})}><Trash2 size={15}/></button></div>
            {s.visual&&<p className="motion-help">已按内容编排：{s.visual.nodes.map(n=>n.label).join(" · ")}。修改总结并保存后更新图解。</p>}{diagram&&<label className="motion-row-field"><span>图解结构</span><select aria-label={`总结 ${i+1} 图解结构`} value={s.diagramLayout||'flow'} disabled={busy} onChange={e=>change({scenes:scenes.map((item,j)=>j===i?{...item,diagramLayout:e.target.value as MotionScene['diagramLayout']}:item)})}><option value="flow">流程：一 → 二 → 三</option><option value="branch">分支：一 → 二 / 三</option><option value="merge">汇总：一 / 二 → 三</option><option value="equation">公式：一 + 二 = 三</option></select></label>}
            {([['headline', '短标题', 18], ['line1', '总结第一行', 26], ['line2', '总结第二行（选填）', 26], ['highlight', '高亮词（选填）', 12]] as const).map(([key, label, max],fieldIndex) => <label className="motion-row-field" key={key}><span>{diagram&&fieldIndex<3?`节点${['一','二','三（选填）'][fieldIndex]}`:label}</span><input maxLength={max} value={s[key]} disabled={busy} onChange={e => change({scenes: scenes.map((item, j) => j === i ? {...item, [key]: e.target.value} : item)})}/></label>)}</div>) : edit.captions.map((c, i) => <div className="motion-caption" key={i}><div className="motion-time"><strong>{i+1}</strong><input aria-label={`字幕 ${i+1} 开始秒`} type="number" min={0} step={0.1} value={c.start} disabled={busy} onChange={e => updateCaption(i, {start: Number(e.target.value)})}/><span>—</span><input aria-label={`字幕 ${i+1} 结束秒`} type="number" min={0} step={0.1} value={c.end} disabled={busy} onChange={e => updateCaption(i, {end: Number(e.target.value)})}/><button aria-label={`删除字幕 ${i+1}`} disabled={busy} onClick={() => change({captions: edit.captions.filter((_, j) => j !== i)})}><Trash2 size={14}/></button></div><textarea aria-label={`字幕 ${i+1} 文字`} value={c.text} maxLength={80} disabled={busy} rows={2} onChange={e => updateCaption(i, {text: e.target.value})}/></div>)}</div>
          {!busy && <button className="motion-add" onClick={() => tab === "scenes" ? change({scenes: [...scenes, {start: scenes.at(-1)?.end || 0, end: duration, headline: "", line1: "", line2: "", highlight: ""}]}) : change({captions: [...edit.captions, {start: edit.captions.at(-1)?.end || 0, end: duration, text: ""}]})}><Plus size={15}/>添加{tab === "scenes" ? "总结片段" : "字幕"}</button>}
          <div className="motion-editor-actions"><button className="motion-button secondary" disabled={busy || !dirty} onClick={() => act("save")}><Save size={15}/>{dirty ? "保存修改" : "已保存"}</button><button className="motion-text-button" disabled={busy} onClick={() => act("analyze")}><RotateCcw size={14}/>{edit.captions.length ? "重新整理总结" : "重试自动识别"}</button></div>
        </>}
      </div>
    </section><aside id="motion-preview" className="motion-preview-column"><div className="motion-preview-sticky"><div className="motion-preview-label"><span className="motion-live-dot"/>{project?.status === "completed" && !dirty ? "已生成成片" : "成片预览"}<small>9:16 · 1080P</small></div>
      {project?.status === "completed" && project.finalUrl && !dirty ? <video className="motion-final" src={project.finalUrl} controls playsInline preload="metadata"/> : <MotionPreview {...preview}/>}
      <p className="motion-preview-note">{!file && !project && !taskVideo ? "示例标题仅用于展示，填写左侧两行文字后生成。" : "标题区 24% · 人物区 48% · 总结区 28%"}</p>
      {project && <button className="motion-button primary motion-render" disabled={busy || !edit.captions.length || !edit.scenes.length} onClick={() => act("render")}>{busy ? <Loader2 className="motion-spin" size={17}/> : <Film size={17}/>}生成动效成片</button>}
      {project?.finalUrl && !dirty && <a className="motion-button download" href={`${project.finalUrl}&download=1`}><Download size={17}/>下载 MP4 成片</a>}
      {project?.status === "completed" && !dirty && <p className="motion-check"><Check size={14}/>原视频声音保留，未重新配音</p>}
      {dirty && project && <p className="motion-preview-note">当前有未保存修改，生成时会一并保存。</p>}
    </div></aside></div>
    <MotionLibrary onApply={applyEffect} applied={edit.effect} disabled={Boolean(busy)}/>
  </main>;
}
