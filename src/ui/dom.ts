export function el<K extends keyof HTMLElementTagNameMap>(tag:K,text='',className=''):HTMLElementTagNameMap[K] {const node=document.createElement(tag);node.textContent=text;node.className=className;return node;}
export function button(text:string,action:()=>void,id?:string):HTMLButtonElement {const node=el('button',text);node.type='button';if(id)node.id=id;node.onclick=action;return node;}
export function field(label:string,id:string,tag:'input'|'select'|'textarea'='input') {const wrapper=el('label',label);wrapper.htmlFor=id;const input=document.createElement(tag);input.id=id;wrapper.append(input);return {wrapper,input};}
export function option(value:string,label:string){const node=el('option',label);node.value=value;return node;}
export function status(){const node=el('p','','notice');node.setAttribute('role','status');node.setAttribute('aria-live','polite');return node;}
