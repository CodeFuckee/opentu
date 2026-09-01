/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { isLikelyMediaBlob } from './blob';

const HTML_HEAD = '<!DOCTYPE html>\r\n<html lang="zh-CN">\r\n  <head>\r\n    <script type="module" src="/src/main.tsx"></script>';

describe('isLikelyMediaBlob', () => {
  it('真实 PNG（image/png + 魔数）→ true', async () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3]);
    expect(await isLikelyMediaBlob(new Blob([png], { type: 'image/png' }))).toBe(true);
  });

  it('真实 JPEG（image/jpeg + FFD8）→ true', async () => {
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 1]);
    expect(await isLikelyMediaBlob(new Blob([jpeg], { type: 'image/jpeg' }))).toBe(true);
  });

  it('真实视频（video/mp4 + ftyp box）→ true', async () => {
    const mp4 = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
    expect(await isLikelyMediaBlob(new Blob([mp4], { type: 'video/mp4' }))).toBe(true);
  });

  it('SVG（image/svg+xml，<?xml 开头）→ true（不能被 HTML 特征误杀）', async () => {
    const svg = '<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg"></svg>';
    expect(await isLikelyMediaBlob(new Blob([svg], { type: 'image/svg+xml' }))).toBe(true);
  });

  it('HTML 兜底页（text/html）→ false', async () => {
    expect(await isLikelyMediaBlob(new Blob([HTML_HEAD], { type: 'text/html' }))).toBe(false);
  });

  it('HTML 兜底页但 MIME 被伪装成 image/png → false（魔数兜底）', async () => {
    expect(await isLikelyMediaBlob(new Blob([HTML_HEAD], { type: 'image/png' }))).toBe(false);
  });

  it('HTML 兜底页（application/octet-stream）→ false', async () => {
    expect(await isLikelyMediaBlob(new Blob([HTML_HEAD], { type: 'application/octet-stream' }))).toBe(false);
  });

  it('明文 JSON 错误页（application/json）→ false', async () => {
    expect(await isLikelyMediaBlob(new Blob(['{"error":"not found"}'], { type: 'application/json' }))).toBe(false);
  });

  it('空 Blob → false', async () => {
    expect(await isLikelyMediaBlob(new Blob([], { type: 'image/png' }))).toBe(false);
  });

  it('null / undefined → false', async () => {
    expect(await isLikelyMediaBlob(null)).toBe(false);
    expect(await isLikelyMediaBlob(undefined)).toBe(false);
  });
});