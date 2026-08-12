/*
  Would You Rather — prompt bank. Workplace-safe, fun, a mix of relatable-office
  and absurd. Each round shows two options; everyone votes; you score a point for
  siding with the majority (the "herd") — on brand for the hub.
*/
export const PROMPTS = [
  { a: 'Always be 10 minutes late', b: 'Always be 20 minutes early' },
  { a: 'Have unlimited free coffee', b: 'Have unlimited free lunch' },
  { a: 'Work four long days', b: 'Work five short days' },
  { a: 'Never have meetings again', b: 'Never have email again' },
  { a: 'Be able to fly', b: 'Be invisible' },
  { a: 'Always know when someone is lying', b: 'Always get away with lying' },
  { a: 'Have a rewind button for life', b: 'Have a pause button for life' },
  { a: 'Be the funniest person in the room', b: 'Be the smartest person in the room' },
  { a: 'Only be able to whisper', b: 'Only be able to shout' },
  { a: 'Fight one horse-sized duck', b: 'Fight 100 duck-sized horses' },
  { a: 'Live without music', b: 'Live without movies' },
  { a: 'Get free travel forever', b: 'Get free food forever' },
  { a: 'Be a morning person', b: 'Be a night owl' },
  { a: 'Speak every language', b: 'Play every instrument' },
  { a: 'Never wait in a line again', b: 'Never get stuck in traffic again' },
  { a: 'Have a personal chef', b: 'Have a personal driver' },
  { a: 'Have to sing instead of speak', b: 'Have to dance everywhere you walk' },
  { a: 'Be famous', b: 'Be rich but anonymous' },
  { a: 'Never lose your keys again', b: 'Never lose your phone again' },
  { a: 'Have a pet dragon', b: 'Have a pet unicorn' },
  { a: 'Only wear formal clothes', b: 'Only wear pyjamas' },
  { a: 'Give up social media forever', b: 'Give up streaming forever' },
  { a: 'Be able to teleport', b: 'Be able to time travel' },
  { a: 'Have unlimited PTO but no raise', b: 'Get a big raise but no extra PTO' },
  { a: 'Be able to read minds', b: 'Be able to predict the future' },
  { a: 'Always be slightly too hot', b: 'Always be slightly too cold' },
  { a: 'Have hiccups for a year', b: 'Feel like you need to sneeze for a year' },
  { a: 'Only communicate in emojis', b: 'Only communicate in GIFs' },
  { a: 'Work from a beach', b: 'Work from a mountain cabin' },
  { a: 'Have every traffic light turn green', b: 'Have every checkout line open for you' },
  { a: 'Never need to sleep', b: 'Never need to eat' },
  { a: 'Win the lottery', b: 'Live twice as long' },
  { a: 'Be amazing at karaoke', b: 'Be amazing at dancing' },
  { a: 'Have a photographic memory', b: 'Be able to forget anything you want' },
  { a: 'Meet your ancestors', b: 'Meet your descendants' },
  { a: 'Be stuck in an elevator with your boss', b: 'Be stuck in an elevator with your ex' },
  { a: 'Have a self-cleaning house', b: 'Have a self-driving car' },
  { a: 'Only eat pizza forever', b: 'Only eat tacos forever' },
  { a: 'Be a wizard', b: 'Be a superhero' },
  { a: 'Have every Monday off', b: 'Leave two hours early every day' },
  { a: 'Explore outer space', b: 'Explore the deep ocean' },
  { a: 'Be able to skip small talk forever', b: 'Be able to rewind awkward moments' },
  { a: 'Be really good at one thing', b: 'Be okay at everything' },
  { a: 'Have a nap room at work', b: 'Have a free snack bar at work' },
  { a: 'Be able to control fire', b: 'Be able to control water' },
  { a: 'Be able to talk to animals', b: 'Be able to speak any human language' },
  { a: 'Have unlimited books', b: 'Have unlimited video games' },
  { a: 'Have a clone of yourself', b: 'Have a robot butler' },
  { a: 'Live in a big city', b: 'Live in the quiet countryside' },
  { a: 'Get a standing ovation for everything you do', b: 'Never be embarrassed again' },
  { a: 'Always have to reply-all', b: 'Always accidentally leave yourself muted' },
  { a: 'Have your camera stuck on in every call', b: 'Have your mic stuck on in every call' },
  { a: 'Take a one-week weekend, once', b: 'Have a three-day weekend, every week' },
  { a: 'Be the main character', b: 'Be the wise mentor' },
  { a: 'Always know the exact time', b: 'Always know which way is north' },
  { a: 'Never feel cold again', b: 'Never feel tired again' },
  { a: 'Be able to pause any conversation', b: 'Be able to mute any person for an hour' },
  { a: 'Have a dedicated parking spot forever', b: 'Have free coffee for life' },
  { a: 'Work with your best friend', b: 'Work for your dream company' },
  { a: 'Always get the window seat', b: 'Always get extra legroom' },
];

export function pickPrompt(usedIndexes = [], size = PROMPTS.length) {
  const all = Array.from({ length: size }, (_, i) => i);
  const pool = all.filter((i) => !usedIndexes.includes(i));
  const from = pool.length ? pool : all;
  return from[Math.floor(Math.random() * from.length)];
}
