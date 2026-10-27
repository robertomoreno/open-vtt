import { expect,it } from 'vitest';
import { parseMessage } from '../../src/session/messages';
it.each([{type:'hello',version:2},{type:'claim',requestId:'r',claim:{playerId:'a',newPlayer:{name:'B',role:'gm'}}},{type:'roll-request',requestId:'r',sides:3},{type:'roll-request',requestId:'r',sides:20,playerId:'spoof'},{type:'snapshot',snapshot:{game:{}}}])('rejects invalid messages %j',message=>expect(()=>parseMessage(message)).toThrow());
