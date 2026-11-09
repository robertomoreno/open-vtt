import { expect, type Download, type Locator, type Page } from '@playwright/test';
import type { DieSides, Role } from '../../../src/game/types';

export class TablePage {
  readonly page: Page;
  readonly title: Locator;
  readonly status: Locator;
  readonly roster: Locator;
  readonly rolls: Locator;
  readonly dieSelect: Locator;
  readonly rollButton: Locator;
  readonly choosePlayerButton: Locator;
  readonly connectButton: Locator;
  readonly leaveButton: Locator;
  readonly downloadButton: Locator;
  readonly downloadRecoveryButton: Locator;
  readonly addPlayerNameInput: Locator;
  readonly addPlayerRoleSelect: Locator;
  readonly addPlayerButton: Locator;
  readonly chatEntries: Locator;
  readonly chatImages: Locator;
  readonly chatInput: Locator;
  readonly sendChatButton: Locator;
  readonly privateToggle: Locator;
  readonly imageInput: Locator;

  constructor(page: Page) {
    this.page = page;
    this.title = page.getByRole('heading', { level: 1 });
    this.status = page.locator('.screen > [role="status"]');
    this.roster = page.locator('.roster');
    this.rolls = page.locator('[data-roll]');
    this.dieSelect = page.getByRole('combobox', { name: 'Die', exact: true });
    this.rollButton = page.getByRole('button', { name: 'Roll the dice' });
    this.choosePlayerButton = page.getByRole('button', { name: 'Choose player' });
    this.connectButton = page.getByRole('button', { name: /^(Connect|Reconnect|Share link)$/ });
    this.leaveButton = page.getByRole('button', { name: 'Leave table' });
    this.downloadButton = page.getByRole('button', { name: 'Download game JSON' });
    this.downloadRecoveryButton = page.getByRole('button', { name: 'Download recovery copy' });
    this.addPlayerNameInput = page.getByLabel('New player name');
    this.addPlayerRoleSelect = page.getByLabel('New player role');
    this.addPlayerButton = page.getByRole('button', { name: 'Add player' });
    this.chatEntries = page.locator('[data-chat]');
    this.chatImages = page.locator('[data-chat] img.chat-image');
    this.chatInput = page.getByLabel('Message', { exact: true });
    this.sendChatButton = page.getByRole('button', { name: 'Send', exact: true });
    this.privateToggle = page.getByLabel('Private message', { exact: true });
    this.imageInput = page.locator('#chat-image-input');
  }

  async roll(): Promise<void> {
    await this.rollButton.click();
  }

  async chooseDie(sides: DieSides): Promise<void> {
    await this.dieSelect.selectOption(String(sides));
  }

  async focusRoll(): Promise<void> {
    await this.rollButton.focus();
  }

  async choosePlayer(): Promise<void> {
    await this.choosePlayerButton.click();
  }

  async addPlayer(name: string, role: Role = 'pj'): Promise<void> {
    await expect(this.addPlayerNameInput).toBeEnabled({ timeout: 60_000 });
    await this.addPlayerNameInput.fill(name);
    await this.addPlayerRoleSelect.selectOption(role);
    await expect(this.addPlayerButton).toBeEnabled({ timeout: 60_000 });
    await this.addPlayerButton.click();
    await expect(this.addPlayerNameInput).toHaveValue('', { timeout: 60_000 });
  }

  rosterEntry(name: string): Locator {
    return this.roster.locator('li', { hasText: name }).first();
  }

  async sendChat(text: string): Promise<void> {
    await this.chatInput.fill(text);
    await this.sendChatButton.click();
    await expect(this.chatInput).toHaveValue('');
  }

  async sendPrivateChat(text: string, recipients: string[]): Promise<void> {
    await this.privateToggle.check();
    for (const name of recipients) await this.page.getByRole('checkbox', { name, exact: true }).check();
    await this.sendChat(text);
  }

  async attachImage(file: { name: string; mimeType: string; buffer: Buffer }): Promise<void> {
    await this.imageInput.setInputFiles(file);
    await expect(this.page.locator('.chat-preview img')).toBeVisible();
  }

  async sendAttachedImage(): Promise<void> {
    await this.sendChatButton.click();
    await expect(this.page.locator('.chat-preview')).toBeHidden();
  }

  async openRoom(): Promise<void> {
    await this.connectButton.click();
  }

  async leave(): Promise<void> {
    await this.leaveButton.click();
  }

  async downloadGame(): Promise<Download> {
    const download = this.page.waitForEvent('download');
    await this.downloadButton.click();
    return download;
  }

  async downloadGamePath(): Promise<string> {
    const download = await this.downloadGame();
    const path = await download.path();
    if (!path) throw new Error('The game download did not produce a local file.');
    return path;
  }

  async downloadRecovery(): Promise<Download> {
    const download = this.page.waitForEvent('download');
    await this.downloadRecoveryButton.click();
    return download;
  }
}
