export function memoryStorage(): Storage {
 const data=new Map<string,string>(); return {get length(){return data.size;},key:n=>[...data.keys()][n]??null,getItem:key=>data.get(key)??null,setItem:(key,value)=>{data.set(key,value);},removeItem:key=>{data.delete(key);},clear:()=>data.clear()};
}
