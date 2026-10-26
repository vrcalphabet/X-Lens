export const SAMPLES = {
  fruit: { cover: 'apple.jpg', secret: 'banana.jpg' },
  human: { cover: 'human.jpg', secret: 'human-crown.jpg' },
  skytree: { cover: 'skytree-red.jpg', secret: 'skytree-green.jpg' },
};

const cache = new Map();

async function loadImage(file) {
  const res = await fetch(`${import.meta.env.BASE_URL}samples/${file}`);
  if (!res.ok) throw new Error(`sample ${file}: HTTP ${res.status}`);
  return createImageBitmap(await res.blob());
}

export function loadSamplePair(id) {
  const sample = SAMPLES[id];
  if (!sample) return Promise.reject(new Error(`unknown sample: ${id}`));
  if (!cache.has(id)) {
    const pair = Promise.all([loadImage(sample.cover), loadImage(sample.secret)]).then(
      ([cover, secret]) => ({
        cover: { source: cover, file: sample.cover },
        secret: { source: secret, file: sample.secret },
      })
    );
    pair.catch(() => cache.delete(id));
    cache.set(id, pair);
  }
  return cache.get(id);
}
