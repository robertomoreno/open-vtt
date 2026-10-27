import { mountApp } from './ui/app';
import './ui/styles.css';
const app=mountApp(document.querySelector<HTMLElement>('#app')!);
window.addEventListener('pagehide',()=>app.destroy(),{once:true});
