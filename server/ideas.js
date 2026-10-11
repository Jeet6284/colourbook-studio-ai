'use strict';
// Builds a list of distinct page ideas for a topic. Built-in banks cover the common categories;
// any other topic falls back to scene templates around the user's words.
const BANKS = {
  animals: ['a friendly lion with a big mane', 'a smiling elephant spraying water', 'a cute puppy sitting', 'a sleepy kitten curled up', 'a giraffe eating leaves', 'a happy monkey hanging from a branch', 'a baby panda eating bamboo', 'a slow tortoise', 'a rabbit holding a carrot', 'a fox in the forest', 'a zebra standing in a field', 'a baby kangaroo in its mother\'s pouch', 'a polar bear on an iceberg', 'a hedgehog in autumn leaves', 'a cow on a farm', 'a friendly horse', 'a owl on a branch', 'a pig playing in mud'],
  birds: ['a parrot on a branch', 'a flamingo standing on one leg', 'a peacock with open feathers', 'a robin on a garden fence', 'a duck with ducklings', 'an owl at night', 'a hummingbird near a flower', 'a toucan with a big beak', 'a penguin family', 'an eagle soaring', 'a swan on a pond', 'a chick hatching from an egg', 'a bluebird in a nest', 'a rooster on a farm', 'a woodpecker on a tree', 'a pelican by the sea'],
  flowers: ['a big sunflower', 'a bouquet of tulips', 'a rose with leaves', 'daisies in a meadow', 'a lotus flower on a pond', 'a vase of wildflowers', 'a bee visiting a flower', 'a butterfly on a flower', 'a garden with many flowers', 'a poppy field', 'a lily with long petals', 'a flower crown', 'a potted plant on a windowsill', 'lavender stems'],
  dinosaurs: ['a friendly T-Rex', 'a long-necked brachiosaurus', 'a triceratops with three horns', 'a stegosaurus with back plates', 'a baby dinosaur hatching', 'a flying pterodactyl', 'a spinosaurus near a river', 'an ankylosaurus', 'a velociraptor running', 'dinosaurs near a volcano', 'a dinosaur eating leaves', 'a dinosaur family', 'a diplodocus in a swamp', 'a dinosaur skeleton in a museum'],
  vehicles: ['a race car speeding', 'a big monster truck', 'a fire truck with a ladder', 'a school bus', 'a police car', 'a tractor in a field', 'a jumbo jet airplane', 'a sailing boat', 'a steam train', 'a helicopter', 'a bulldozer', 'an ambulance', 'a motorbike', 'a hot air balloon', 'a vintage car', 'a submarine'],
  cartoon: ['a cheerful robot', 'a friendly monster', 'a brave little knight', 'a smiling princess in a castle', 'a happy wizard with a wand', 'a pirate with a treasure map', 'a cute alien waving', 'a superhero kid flying', 'a mermaid under the sea', 'a dragon with tiny wings', 'a friendly ghost', 'a unicorn with a rainbow', 'a fairy with sparkles', 'a snowman with a scarf'],
  ocean: ['a smiling dolphin jumping', 'a turtle swimming', 'an octopus with eight arms', 'a clownfish near an anemone', 'a whale spouting water', 'a seahorse', 'a crab on the beach', 'a jellyfish', 'a starfish and shells', 'a shark with friendly teeth', 'a coral reef scene', 'a pufferfish', 'a mermaid and fish', 'a lighthouse by the sea'],
  space: ['a rocket launching', 'an astronaut floating', 'the solar system', 'a ringed planet', 'a friendly alien spaceship', 'a moon with craters and stars', 'a telescope looking at stars', 'a space station', 'a comet', 'a rover on Mars', 'a satellite orbiting Earth', 'a smiling sun and planets'],
  patterns: ['a round mandala', 'a floral mandala', 'a geometric mandala', 'a butterfly pattern', 'a leaf pattern', 'a paisley pattern', 'a sun mandala', 'a snowflake pattern', 'a feather pattern', 'a wave pattern', 'a star mandala', 'a flower of life pattern', 'a heart mandala', 'a lace circle pattern'],
};
const ALIASES = {
  animals: ['animal', 'pet', 'zoo', 'farm', 'wildlife', 'jungle', 'safari', 'cat', 'dog'],
  birds: ['bird', 'parrot', 'owl', 'duck'],
  flowers: ['flower', 'garden', 'floral', 'rose', 'plant', 'nature', 'tree'],
  dinosaurs: ['dinosaur', 'dino', 'jurassic', 'prehistoric'],
  vehicles: ['car', 'cars', 'vehicle', 'truck', 'train', 'plane', 'transport', 'bike', 'bus'],
  cartoon: ['cartoon', 'character', 'fairy', 'princess', 'robot', 'monster', 'superhero', 'fantasy'],
  ocean: ['ocean', 'sea', 'fish', 'marine', 'underwater', 'whale', 'shark'],
  space: ['space', 'rocket', 'planet', 'astronaut', 'galaxy', 'star'],
  patterns: ['mandala', 'pattern', 'zentangle', 'geometric', 'abstract'],
};
const SCENES = ['', ', with a smiling sun and clouds', ', surrounded by flowers', ', under a big rainbow', ', next to a tree', ', with butterflies around'];
const GENERIC = ['a cute cartoon {t}', '{t} in a sunny meadow', '{t} at the beach', 'a happy family of {t}', '{t} with balloons', '{t} in a magical forest', '{t} on a rainy day with an umbrella', '{t} in a snowy landscape', '{t} playing in a park', '{t} at night under the stars', '{t} in a village', '{t} on an adventure', '{t} having a picnic', '{t} with a rainbow', '{t} in a garden', '{t} on a mountain'];

function shuffle(arr, rnd) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
function pickBank(topic) {
  const t = topic.toLowerCase();
  const words = t.split(/[^a-z]+/).filter(Boolean);
  const stem = (w) => w.replace(/(es|s)$/, '');
  for (const [key, names] of Object.entries(ALIASES)) {
    if (words.some((w) => w === key || names.includes(w) || names.includes(stem(w)))) return key;
  }
  return null;
}
function makeIdeas(topic, count, rnd = Math.random) {
  const t = String(topic || '').trim();
  const key = pickBank(t);
  const out = [];
  if (key) {
    const base = shuffle(BANKS[key], rnd);
    for (let round = 0; out.length < count; round++) {
      for (const idea of base) {
        if (out.length >= count) break;
        out.push(round === 0 ? idea : idea + SCENES[(round + out.length) % SCENES.length]);
      }
    }
  } else {
    const tt = shuffle(GENERIC, rnd);
    for (let i = 0; i < count; i++) {
      const round = Math.floor(i / tt.length);
      out.push(tt[i % tt.length].replace('{t}', t) + (round ? SCENES[round % SCENES.length] : ''));
    }
  }
  return out;
}
const bankKeyFor = pickBank;
module.exports = { makeIdeas, bankKeyFor };
