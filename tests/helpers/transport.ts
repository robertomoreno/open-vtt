import type { PeerTransport,TransportEvent,TransportState } from '../../src/network/peer';
export function pair() {
 const listeners=[new Set<(e:TransportEvent)=>void>(),new Set<(e:TransportEvent)=>void>()];const states:TransportState[]=['open','open'];
 const peers=[0,1].map(n=>({id:crypto.randomUUID(),get state(){return states[n];},send(value:unknown){if(states[n]==='open')for(const fn of [...listeners[1-n]])fn({type:'message',value:structuredClone(value)});},subscribe(fn:(e:TransportEvent)=>void){listeners[n].add(fn);return ()=>{listeners[n].delete(fn);};},close(){for(const i of [n,1-n]){states[i]='closed';for(const fn of [...listeners[i]])fn({type:'state',state:'closed'});}}})) as [PeerTransport,PeerTransport];
 return peers;
}
