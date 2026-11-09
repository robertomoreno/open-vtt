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
