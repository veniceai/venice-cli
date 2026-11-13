import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { NO_VIDEO_INPUTS, parseCameraTrajectory, referenceVideoSeconds, videoInputsBody } from './video-inputs.js';

const keyframe = (time: number, azimuth = 0, elevation = 0, distance = 1) => ({ time, azimuth, elevation, distance });

function mp4WithSeconds(seconds: number): Buffer {
  const box = (type: string, content: Buffer) => {
    const header = Buffer.alloc(8);
    header.writeUInt32BE(content.length + 8, 0);
    header.write(type, 4, 'latin1');
    return Buffer.concat([header, content]);
  };
  const mvhd = Buffer.alloc(96);
  mvhd.writeUInt32BE(1000, 12);
  mvhd.writeUInt32BE(Math.round(seconds * 1000), 16);
  return Buffer.concat([box('ftyp', Buffer.from('isom\0\0\0\0isommp41', 'latin1')), box('moov', box('mvhd', mvhd))]);
}

test('parseCameraTrajectory accepts 2 to 12 keyframes and rejects paths the API refuses', () => {
  assert.deepEqual(parseCameraTrajectory([keyframe(0), keyframe(1, 90, 10, 1.5)]), [keyframe(0), keyframe(1, 90, 10, 1.5)]);

  const cases: Array<[unknown, RegExp]> = [
    [[keyframe(0)], /2 to 12 keyframes/],
    [Array.from({ length: 13 }, (_, index) => keyframe(index / 12)), /2 to 12 keyframes/],
    [[keyframe(0.5), keyframe(0.5)], /keyframe times must strictly increase/],
    [[keyframe(0), keyframe(1.5)], /keyframe 2: "time" must be a number between 0 and 1/],
    [[keyframe(0, 0, 91), keyframe(1)], /keyframe 1: "elevation" must be a number between -90 and 90/],
    [[keyframe(0, 0, 0, 0), keyframe(1)], /keyframe 1: "distance" must be a number greater than 0/],
    [[{ ...keyframe(0), zoom: 2 }, keyframe(1)], /keyframe 1: unknown field "zoom"/],
    [[keyframe(0), keyframe(1, 32 * 360 + 1)], /more than 32 turns/],
  ];
  for (const [value, message] of cases) {
    assert.throws(() => parseCameraTrajectory(value), message);
  }
});

test('videoInputsBody passes URLs through and nests typed inputs the way the API expects', () => {
  const url = (name: string) => ({ kind: 'url' as const, url: `https://media.example/${name}` });

  assert.deepEqual(videoInputsBody({
    ...NO_VIDEO_INPUTS,
    start: { image: url('start.png'), cameraTrajectory: [keyframe(0), keyframe(1)] },
    references: {
      visual: [{ kind: 'image', media: url('ref.png') }, { kind: 'video', media: url('ref.mp4') }],
      audio: [url('voice.wav')],
    },
    imageReferences: [{ image: url('alice.png'), type: 'subject', name: 'Alice', audio: url('alice.mp3') }],
    elements: [{ video: url('element.mp4'), referenceImages: [] }],
  }), {
    image_url: 'https://media.example/start.png',
    camera_trajectory: [keyframe(0), keyframe(1)],
    reference_image_urls: ['https://media.example/ref.png'],
    reference_video_urls: ['https://media.example/ref.mp4'],
    reference_audio_urls: ['https://media.example/voice.wav'],
    image_references: [{
      image_url: 'https://media.example/alice.png',
      type: 'subject',
      ref_name: 'Alice',
      audio_url: 'https://media.example/alice.mp3',
    }],
    elements: [{ video_url: 'https://media.example/element.mp4' }],
  });
  assert.deepEqual(videoInputsBody(NO_VIDEO_INPUTS), {});
});

test('referenceVideoSeconds totals local reference videos and gives up on one it cannot measure', () => {
  const dir = mkdtempSync(join(tmpdir(), 'venice-reference-seconds-'));
  try {
    const file = (name: string, seconds: number) => {
      const filePath = join(dir, name);
      writeFileSync(filePath, mp4WithSeconds(seconds));
      return { kind: 'file' as const, path: filePath, dataUrl: 'data:video/mp4;base64,' };
    };
    const clip = file('clip.mp4', 3);

    assert.equal(referenceVideoSeconds(NO_VIDEO_INPUTS), undefined);
    assert.equal(referenceVideoSeconds({
      ...NO_VIDEO_INPUTS,
      references: { visual: [{ kind: 'video', media: clip }], audio: [] },
      videoReferences: [{ video: file('typed.mov', 4.5) }],
    }), 7.5);
    assert.equal(referenceVideoSeconds({
      ...NO_VIDEO_INPUTS,
      references: { visual: [{ kind: 'video', media: clip }, { kind: 'video', media: { kind: 'url', url: 'https://media.example/x.mp4' } }], audio: [] },
    }), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
