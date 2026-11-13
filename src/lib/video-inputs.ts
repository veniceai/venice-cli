/**
 * Media inputs for video generation. Each one is a public URL or a local file sent inline, checked against
 * the formats and sizes the API documents before anything is queued.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  assertFileSizeWithinLimit,
  fileToDataUrl,
  MAX_REFERENCE_VIDEO_BYTES,
  MAX_VIDEO_INPUT_AUDIO_BYTES,
  MAX_VIDEO_REFERENCE_IMAGE_BYTES,
  MAX_VIDEO_UPSCALE_BYTES,
} from './media.js';
import { mp4DurationSeconds } from './mp4.js';
import type { NonEmpty } from '../types/index.js';

export const TASK_TYPES = ['auto', 'reference', 'edit', 'extend'] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export type Media = { kind: 'url'; url: string } | { kind: 'file'; path: string; dataUrl: string };

export type CameraKeyframe = { time: number; azimuth: number; elevation: number; distance: number };

export type Element = ({ frontalImage: Media; video?: Media } | { frontalImage?: Media; video: Media }) & {
  referenceImages: Media[];
};

export type ImageReference = { image: Media; type?: 'subject' | 'background'; name?: string; audio?: Media };

export type VideoReference = { video: Media; name?: string; audio?: Media };

export type VisualReference = { kind: 'image'; media: Media } | { kind: 'video'; media: Media };

export type VideoInputs = {
  // The API only accepts a camera trajectory together with the start image it moves from.
  start?: { image: Media; cameraTrajectory?: NonEmpty<CameraKeyframe> };
  endImage?: Media;
  video?: Media;
  audio?: Media;
  // Reference audio is rejected unless at least one reference image or video goes with it.
  references?: { visual: NonEmpty<VisualReference>; audio: Media[] };
  imageReferences: ImageReference[];
  videoReferences: VideoReference[];
  elements: Element[];
  sceneImages: Media[];
};

export const NO_VIDEO_INPUTS: VideoInputs = { imageReferences: [], videoReferences: [], elements: [], sceneImages: [] };

/** The raw values of the generate flags that carry media. */
export type VideoInputFlags = {
  image?: string;
  endImage?: string;
  video?: string;
  audioInput?: string;
  referenceImage: string[];
  referenceVideo: string[];
  referenceAudio: string[];
  imageReference: string[];
  videoReference: string[];
  element: string[];
  sceneImage: string[];
  cameraTrajectory?: string;
};

type MediaKind = 'image' | 'video' | 'reference video' | 'audio';

const MEDIA_RULES: Record<MediaKind, { extensions: NonEmpty<string>; maxBytes: number }> = {
  image: { extensions: ['.png', '.jpg', '.jpeg', '.webp'], maxBytes: MAX_VIDEO_REFERENCE_IMAGE_BYTES },
  video: { extensions: ['.mp4', '.mov', '.webm'], maxBytes: MAX_VIDEO_UPSCALE_BYTES },
  'reference video': { extensions: ['.mp4', '.mov'], maxBytes: MAX_REFERENCE_VIDEO_BYTES },
  audio: { extensions: ['.wav', '.mp3'], maxBytes: MAX_VIDEO_INPUT_AUDIO_BYTES },
};

const MAX_JSON_OPTION_BYTES = 1024 * 1024;
const MAX_AZIMUTH_TRAVEL_DEGREES = 32 * 360;

const LIST_LIMITS: Array<[keyof VideoInputFlags, string, number]> = [
  ['referenceImage', '--reference-image', 30],
  ['referenceVideo', '--reference-video', 10],
  ['referenceAudio', '--reference-audio', 10],
  ['imageReference', '--image-reference', 30],
  ['videoReference', '--video-reference', 5],
  ['element', '--element', 4],
  ['sceneImage', '--scene-image', 4],
];

export function isPublicHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

async function readMedia(value: string, kind: MediaKind, flag: string): Promise<Media> {
  if (isPublicHttpUrl(value)) return { kind: 'url', url: value };
  const filePath = path.resolve(value);
  if (!fs.existsSync(filePath)) {
    throw new Error(`${flag}: ${value} is not a file or an http(s) URL.`);
  }
  const { extensions, maxBytes } = MEDIA_RULES[kind];
  if (!extensions.includes(path.extname(filePath).toLowerCase())) {
    throw new Error(`${flag}: ${value} must be one of ${extensions.join(', ')}.`);
  }
  return { kind: 'file', path: filePath, dataUrl: await fileToDataUrl(filePath, maxBytes, `${flag} file`) };
}

export function mediaUrl(media: Media): string {
  return media.kind === 'url' ? media.url : media.dataUrl;
}

/** Inline JSON, when the value starts with { or [, or else the path of a JSON file. */
export function readJsonOption(value: string, flag: string): unknown {
  let text = value;
  if (!/^\s*[[{]/.test(value)) {
    const filePath = path.resolve(value);
    if (!fs.existsSync(filePath)) throw new Error(`${flag} must be JSON or the path of a JSON file.`);
    assertFileSizeWithinLimit(filePath, MAX_JSON_OPTION_BYTES, `${flag} file`);
    text = fs.readFileSync(filePath, 'utf8');
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${flag} is not valid JSON.`);
  }
}

function jsonObject(value: unknown, label: string, keys: NonEmpty<string>): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be a JSON object.`);
  const unknownKeys = Object.keys(value).filter((key) => !keys.includes(key));
  if (unknownKeys.length > 0) {
    throw new Error(`${label}: unknown field "${unknownKeys[0]}". Use ${keys.join(', ')}.`);
  }
  return value as Record<string, unknown>;
}

function optionalString(record: Record<string, unknown>, key: string, label: string): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value === '') throw new Error(`${label}: "${key}" must be a non-empty string.`);
  return value;
}

function requiredString(record: Record<string, unknown>, key: string, label: string): string {
  const value = optionalString(record, key, label);
  if (value === undefined) throw new Error(`${label}: "${key}" is required.`);
  return value;
}

async function optionalMedia(value: string | undefined, kind: MediaKind, flag: string): Promise<Media | undefined> {
  return value === undefined ? undefined : readMedia(value, kind, flag);
}

export function parseCameraTrajectory(value: unknown, flag = '--camera-trajectory'): NonEmpty<CameraKeyframe> {
  if (!Array.isArray(value) || value.length < 2 || value.length > 12) {
    throw new Error(`${flag} must be a JSON array of 2 to 12 keyframes.`);
  }
  const keyframes = value.map((entry: unknown, index): CameraKeyframe => {
    const label = `${flag} keyframe ${index + 1}`;
    const record = jsonObject(entry, label, ['time', 'azimuth', 'elevation', 'distance']);
    const number = (key: string, min: number, max: number, exclusiveMin = false): number => {
      const field = record[key];
      if (typeof field !== 'number' || !Number.isFinite(field) || field > max || field < min || (exclusiveMin && field === min)) {
        const range = max === Infinity ? `${exclusiveMin ? 'greater than' : 'at least'} ${min}` : `between ${min} and ${max}`;
        throw new Error(`${label}: "${key}" must be a number ${range}.`);
      }
      return field;
    };
    return {
      time: number('time', 0, 1),
      azimuth: number('azimuth', -Infinity, Infinity),
      elevation: number('elevation', -90, 90),
      distance: number('distance', 0, Infinity, true),
    };
  });

  let azimuthTravel = 0;
  keyframes.forEach((keyframe, index) => {
    const previous = keyframes[index - 1];
    if (!previous) return;
    if (keyframe.time <= previous.time) throw new Error(`${flag}: keyframe times must strictly increase.`);
    azimuthTravel += Math.abs(keyframe.azimuth - previous.azimuth);
  });
  if (azimuthTravel > MAX_AZIMUTH_TRAVEL_DEGREES) {
    throw new Error(`${flag}: the azimuth travels ${azimuthTravel} degrees in total, more than 32 turns.`);
  }

  const [first, ...rest] = keyframes;
  if (!first) throw new Error(`${flag} must be a JSON array of 2 to 12 keyframes.`);
  return [first, ...rest];
}

async function parseElement(value: string, label: string): Promise<Element> {
  const record = jsonObject(readJsonOption(value, label), label, ['frontal_image', 'reference_images', 'video']);
  const references = record.reference_images ?? [];
  if (!Array.isArray(references) || !references.every((item) => typeof item === 'string' && item !== '')) {
    throw new Error(`${label}: "reference_images" must be a list of files or URLs.`);
  }
  if (references.length > 3) throw new Error(`${label}: "reference_images" takes at most 3 images.`);
  const referenceImages = await Promise.all(references.map((item: string) => readMedia(item, 'image', label)));
  const frontal = optionalString(record, 'frontal_image', label);
  const video = await optionalMedia(optionalString(record, 'video', label), 'video', label);
  if (frontal !== undefined) return { frontalImage: await readMedia(frontal, 'image', label), video, referenceImages };
  if (video) return { video, referenceImages };
  throw new Error(`${label} needs a "frontal_image" or a "video".`);
}

const isImageSide = (value: string): value is 'subject' | 'background' => value === 'subject' || value === 'background';

async function parseImageReference(value: string, label: string): Promise<ImageReference> {
  const record = jsonObject(readJsonOption(value, label), label, ['image', 'type', 'name', 'audio']);
  const type = optionalString(record, 'type', label);
  if (type !== undefined && !isImageSide(type)) throw new Error(`${label}: "type" must be subject or background.`);
  return {
    image: await readMedia(requiredString(record, 'image', label), 'image', label),
    type,
    name: optionalString(record, 'name', label),
    audio: await optionalMedia(optionalString(record, 'audio', label), 'audio', label),
  };
}

async function parseVideoReference(value: string, label: string): Promise<VideoReference> {
  const record = jsonObject(readJsonOption(value, label), label, ['video', 'name', 'audio']);
  return {
    video: await readMedia(requiredString(record, 'video', label), 'video', label),
    name: optionalString(record, 'name', label),
    audio: await optionalMedia(optionalString(record, 'audio', label), 'audio', label),
  };
}

export async function parseVideoInputs(flags: VideoInputFlags): Promise<VideoInputs> {
  for (const [key, flag, limit] of LIST_LIMITS) {
    const values = flags[key];
    if (Array.isArray(values) && values.length > limit) throw new Error(`${flag} accepts at most ${limit} values.`);
  }
  if (flags.cameraTrajectory !== undefined && flags.image === undefined) {
    throw new Error('--camera-trajectory needs a start image (-i).');
  }
  if (flags.referenceAudio.length > 0 && flags.referenceImage.length === 0 && flags.referenceVideo.length === 0) {
    throw new Error('--reference-audio needs a --reference-image or --reference-video to go with it.');
  }

  const cameraTrajectory = flags.cameraTrajectory === undefined
    ? undefined
    : parseCameraTrajectory(readJsonOption(flags.cameraTrajectory, '--camera-trajectory'));
  const listed = (values: string[], kind: MediaKind, flag: string) =>
    Promise.all(values.map((value) => readMedia(value, kind, flag)));
  const numbered = <T>(values: string[], flag: string, parse: (value: string, label: string) => Promise<T>) =>
    Promise.all(values.map((value, index) => parse(value, values.length > 1 ? `${flag} #${index + 1}` : flag)));

  const startImage = await optionalMedia(flags.image, 'image', '-i');
  const [firstVisual, ...otherVisuals]: VisualReference[] = [
    ...(await listed(flags.referenceImage, 'image', '--reference-image')).map((media) => ({ kind: 'image' as const, media })),
    ...(await listed(flags.referenceVideo, 'reference video', '--reference-video')).map((media) => ({ kind: 'video' as const, media })),
  ];

  return {
    start: startImage && { image: startImage, cameraTrajectory },
    endImage: await optionalMedia(flags.endImage, 'image', '--end-image'),
    video: await optionalMedia(flags.video, 'video', '--video'),
    audio: await optionalMedia(flags.audioInput, 'audio', '--audio-input'),
    references: firstVisual && {
      visual: [firstVisual, ...otherVisuals],
      audio: await listed(flags.referenceAudio, 'audio', '--reference-audio'),
    },
    imageReferences: await numbered(flags.imageReference, '--image-reference', parseImageReference),
    videoReferences: await numbered(flags.videoReference, '--video-reference', parseVideoReference),
    elements: await numbered(flags.element, '--element', parseElement),
    sceneImages: await listed(flags.sceneImage, 'image', '--scene-image'),
  };
}

/** The /video/queue fields for the inputs, with local files as data URLs. */
export function videoInputsBody(inputs: VideoInputs): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (inputs.start) {
    body.image_url = mediaUrl(inputs.start.image);
    if (inputs.start.cameraTrajectory) body.camera_trajectory = inputs.start.cameraTrajectory;
  }
  if (inputs.endImage) body.end_image_url = mediaUrl(inputs.endImage);
  if (inputs.video) body.video_url = mediaUrl(inputs.video);
  if (inputs.audio) body.audio_url = mediaUrl(inputs.audio);
  if (inputs.references) {
    const urls = (kind: VisualReference['kind']) =>
      inputs.references?.visual.filter((reference) => reference.kind === kind).map((reference) => mediaUrl(reference.media)) ?? [];
    if (urls('image').length > 0) body.reference_image_urls = urls('image');
    if (urls('video').length > 0) body.reference_video_urls = urls('video');
    if (inputs.references.audio.length > 0) body.reference_audio_urls = inputs.references.audio.map(mediaUrl);
  }
  if (inputs.imageReferences.length > 0) {
    body.image_references = inputs.imageReferences.map((reference) => ({
      image_url: mediaUrl(reference.image),
      ...(reference.type ? { type: reference.type } : {}),
      ...(reference.name ? { ref_name: reference.name } : {}),
      ...(reference.audio ? { audio_url: mediaUrl(reference.audio) } : {}),
    }));
  }
  if (inputs.videoReferences.length > 0) {
    body.video_references = inputs.videoReferences.map((reference) => ({
      video_url: mediaUrl(reference.video),
      ...(reference.name ? { ref_name: reference.name } : {}),
      ...(reference.audio ? { audio_url: mediaUrl(reference.audio) } : {}),
    }));
  }
  if (inputs.elements.length > 0) {
    body.elements = inputs.elements.map((element) => ({
      ...(element.frontalImage ? { frontal_image_url: mediaUrl(element.frontalImage) } : {}),
      ...(element.referenceImages.length > 0 ? { reference_image_urls: element.referenceImages.map(mediaUrl) } : {}),
      ...(element.video ? { video_url: mediaUrl(element.video) } : {}),
    }));
  }
  if (inputs.sceneImages.length > 0) body.scene_image_urls = inputs.sceneImages.map(mediaUrl);
  return body;
}

export function hasPerReferenceAudio(inputs: VideoInputs): boolean {
  return [...inputs.imageReferences, ...inputs.videoReferences].some((reference) => reference.audio !== undefined);
}

/**
 * Total seconds of the reference videos, for quotes. Undefined when there are none, or when one is a URL or
 * a file whose length can't be read, because a partial total would under-quote the job.
 */
export function referenceVideoSeconds(inputs: VideoInputs): number | undefined {
  const videos = [
    ...(inputs.references?.visual.filter((reference) => reference.kind === 'video').map((reference) => reference.media) ?? []),
    ...inputs.videoReferences.map((reference) => reference.video),
  ];
  if (videos.length === 0) return undefined;
  let total = 0;
  for (const media of videos) {
    const seconds = media.kind === 'file' ? mp4DurationSeconds(media.path) : undefined;
    if (seconds === undefined) return undefined;
    total += seconds;
  }
  return total;
}
