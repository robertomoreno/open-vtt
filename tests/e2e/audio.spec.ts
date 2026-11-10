import { test, expect } from './support/fixtures';
import { Participant } from './support/participant';
import { wavFixture } from './support/audio';
import { waitForSavedAudio } from './support/storage';

test('players hear the same track and keep private volume', async ({ browser }) => {
  test.setTimeout(240_000);
  const host = await Participant.create(browser), bea = await Participant.create(browser);
  try {
    await host.app.createGame('The Music Table');
    const link = await host.app.openSharedRoom();
    await bea.app.joinSharedRoom(link);
    await host.app.table.addPlayer('Bea');
    await bea.app.claimPlayer('Bea');
    await host.app.music.upload({ name: 'theme.wav', mimeType: 'audio/wav', buffer: wavFixture() });
    await expect(host.app.music.trackRow('theme.wav')).toContainText('Ready');
    await expect(bea.app.music.trackRow('theme.wav')).toContainText('Ready', { timeout: 60_000 });
    await host.app.music.select('theme.wav');
    await host.app.music.toggle();
    await host.app.music.enableSoundIfNeeded();
    await bea.app.music.enableSoundIfNeeded();
    // Headless audio is not audible; a moving shared playhead is the observable proof.
    await expect.poll(async () => host.app.music.currentTime()).toBeGreaterThan(0);
    await expect.poll(async () => bea.app.music.currentTime()).toBeGreaterThan(0);
    await expect.poll(async () => Math.abs(await host.app.music.currentTime() - await bea.app.music.currentTime())).toBeLessThan(0.75);
    // Get both playheads clearly past the seek target first, so moving backwards is observable.
    await expect.poll(async () => Math.min(await host.app.music.currentTime(), await bea.app.music.currentTime())).toBeGreaterThan(5);
    await host.app.music.seek(3000);
    // A shared seek must move both playheads back to ~3 s, not merely leave them past 2.5 s.
    await expect.poll(async () => {
      const hostTime = await host.app.music.currentTime();
      const beaTime = await bea.app.music.currentTime();
      return hostTime >= 2.5 && beaTime >= 2.5 && hostTime < 4.5 && beaTime < 4.5 && Math.abs(hostTime - beaTime) < 0.75;
    }).toBe(true);
    await host.app.music.setGain(160);
    await expect(bea.app.music.gainValue()).toHaveValue('160');
    await host.app.music.setLocal(20);
    await expect(host.app.music.localValue()).toHaveValue('20');
    await expect(bea.app.music.localValue()).toHaveValue('100');
  } finally {
    await host.close(); await bea.close();
  }
});

test('the library persists across reloads and a new holder can serve a late joiner', async ({ browser }) => {
  test.setTimeout(300_000);
  const host = await Participant.create(browser), bea = await Participant.create(browser), cy = await Participant.create(browser);
  try {
    await host.app.createGame('The Music Table');
    const link = await host.app.openSharedRoom();
    await bea.app.joinSharedRoom(link);
    await host.app.table.addPlayer('Bea');
    await bea.app.claimPlayer('Bea');
    // The GM adds Cy while the room is live; Cy claims that seat after joining.
    await host.app.table.addPlayer('Cy');
    await host.app.music.upload({ name: 'theme.wav', mimeType: 'audio/wav', buffer: wavFixture() });
    await expect(bea.app.music.trackRow('theme.wav')).toContainText('Ready', { timeout: 60_000 });
    await waitForSavedAudio(host.app.page, 'The Music Table', 'theme.wav');

    await host.app.page.reload();
    await host.app.start.continueGame('The Music Table');
    await host.app.restore.open();
    await expect(host.app.music.trackRow('theme.wav')).toContainText('Ready', { timeout: 60_000 });

    // The original uploader leaves; Bea still holds the bytes. Cy joins the same room
    // link and must fetch the track from Bea, not from the absent uploader.
    await host.close();
    await cy.app.joinSharedRoom(link);
    await cy.app.claimPlayer('Cy');
    // A late joiner does not auto-download the library: the row is listed without bytes
    // until selecting the missing current track requests them from a connected holder.
    const cyRow = cy.app.music.trackRow('theme.wav');
    await expect(cyRow).toBeVisible({ timeout: 60_000 });
    await expect(cyRow).not.toContainText('Ready');
    // No current track is playing, so the library must still be metadata-only after the
    // first availability refresh settles rather than racing into an auto-download.
    await cy.app.page.waitForTimeout(1_000);
    await expect(cyRow).not.toContainText('Ready');
    await cy.app.music.select('theme.wav');
    await expect(cyRow).toContainText('Ready', { timeout: 90_000 });
    await cy.app.music.toggle();
    await cy.app.music.enableSoundIfNeeded();
    await expect.poll(async () => cy.app.music.currentTime()).toBeGreaterThan(0);
  } finally {
    await host.close().catch(() => {});
    await bea.close();
    await cy.close();
  }
});

test('a late joiner joins a playing track at the current position', async ({ browser }) => {
  test.setTimeout(300_000);
  const host = await Participant.create(browser), bea = await Participant.create(browser), cy = await Participant.create(browser);
  try {
    await host.app.createGame('The Music Table');
    const link = await host.app.openSharedRoom();
    await bea.app.joinSharedRoom(link);
    await host.app.table.addPlayer('Bea');
    await bea.app.claimPlayer('Bea');
    await host.app.music.upload({ name: 'theme.wav', mimeType: 'audio/wav', buffer: wavFixture() });
    await expect(bea.app.music.trackRow('theme.wav')).toContainText('Ready', { timeout: 60_000 });

    await host.app.music.select('theme.wav');
    await host.app.music.toggle();
    await host.app.music.enableSoundIfNeeded();
    await bea.app.music.enableSoundIfNeeded();
    await expect.poll(async () => Math.min(await host.app.music.currentTime(), await bea.app.music.currentTime())).toBeGreaterThan(2);

    // Cy is seated while the host is still connected, then joins the playing room.
    await host.app.table.addPlayer('Cy');
    await cy.app.joinSharedRoom(link);
    await cy.app.claimPlayer('Cy');

    // A late joiner auto-fetches the current track and probes the holder's position.
    const cyRow = cy.app.music.trackRow('theme.wav');
    await expect(cyRow).toBeVisible({ timeout: 60_000 });
    await expect(cyRow).toContainText('Ready', { timeout: 90_000 });
    await cy.app.music.enableSoundIfNeeded();
    await expect.poll(async () => cy.app.music.currentTime()).toBeGreaterThan(0);
    await expect.poll(async () => {
      const hostTime = await host.app.music.currentTime();
      const cyTime = await cy.app.music.currentTime();
      return Math.abs(hostTime - cyTime);
    }).toBeLessThan(1.5);
  } finally {
    await host.close();
    await bea.close();
    await cy.close();
  }
});
