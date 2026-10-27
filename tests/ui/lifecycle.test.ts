// @vitest-environment jsdom
import { expect,it } from 'vitest';
it('remounts the saved start screen after persisted pagehide and pageshow',async()=>{
 document.body.innerHTML='<main id="app"></main>';localStorage.clear();await import('../../src/main');
 document.querySelector<HTMLInputElement>('#game-name')!.value='Return to the table';document.querySelector<HTMLInputElement>('#creator-name')!.value='Alex';document.querySelector<HTMLFormElement>('#new-game')!.requestSubmit();
 expect(document.querySelector('#roll')).not.toBeNull();window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true}));window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}));
 expect(document.querySelector('#new-game')).not.toBeNull();expect(document.body.textContent).toContain('Return to the table');expect(document.querySelectorAll('#new-game')).toHaveLength(1);window.dispatchEvent(new PageTransitionEvent('pagehide'));
});
