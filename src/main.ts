import { mountApp } from './ui/app';
import './ui/styles.css';
const root=document.querySelector<HTMLElement>('#app')!;
let app:ReturnType<typeof mountApp>|null=mountApp(root);
window.addEventListener('pagehide',()=>{app?.destroy();app=null;});
window.addEventListener('pageshow',event=>{
  // BFCache restores this document without re-running the entry module.
  // Connections were closed on departure; return to durable local saves.
  if(event.persisted&&!app)app=mountApp(root);
});
