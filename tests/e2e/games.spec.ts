import { test,expect } from '@playwright/test';
import { createGame,countRolls } from './helpers';
test('create refresh restore and portable file roundtrip',async({page,browser})=>{
 await createGame(page);await page.locator('#roll').click();await countRolls(page,1);await page.reload();await page.getByRole('button',{name:'Continue'}).click();await expect(page.getByLabel('Host as player')).toHaveValue(/.+/);await page.getByRole('button',{name:'Open game',exact:true}).click();await countRolls(page,1);
 const downloadPromise=page.waitForEvent('download');await page.locator('#download').click();const file=await downloadPromise;const path=(await file.path())!;
 const context=await browser.newContext(),fresh=await context.newPage();await fresh.goto('/');await fresh.getByLabel('Load state file').setInputFiles(path);await fresh.getByRole('button',{name:'Open game',exact:true}).click();await expect(fresh.getByRole('heading',{name:'The Lantern Road'})).toBeVisible();await countRolls(fresh,1);await context.close();
});
test('invalid and canceled replacement imports preserve existing saves',async({page})=>{
 await createGame(page);const promise=page.waitForEvent('download');await page.locator('#download').click();const path=(await(await promise).path())!;await page.locator('#leave').click();await page.getByLabel('Load state file').setInputFiles(path);await expect(page.getByRole('button',{name:'Replace saved game and open'})).toBeVisible();await page.getByRole('button',{name:'Cancel',exact:true}).click();
 await page.getByLabel('Load state file').setInputFiles({name:'invalid.json',mimeType:'application/json',buffer:Buffer.from('{"schemaVersion":2}')});await expect(page.getByText('Unsupported game schema version.')).toBeVisible();await expect(page.getByRole('button',{name:'Continue'})).toHaveCount(1);
});
test('responsive keyboard forms preserve die selection and safe text',async({page})=>{
 await page.setViewportSize({width:390,height:844});await createGame(page,'<img onerror=alert(1)>');await expect(page.locator('img')).toHaveCount(0);await page.getByRole('combobox',{name:'Die',exact:true}).selectOption('6');await page.locator('#roll').focus();await page.keyboard.press('Enter');await countRolls(page,1);await expect(page.getByRole('combobox',{name:'Die',exact:true})).toHaveValue('6');await expect(page.locator('#roll')).toBeFocused();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.screenshot({path:`test-results/table-${test.info().project.name}.png`,fullPage:true});
});
