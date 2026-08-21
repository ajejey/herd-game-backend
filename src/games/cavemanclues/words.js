/*
  The word bank for Caveman Clues.

  A word earns its place by being hard to DESCRIBE in one-syllable words, not by
  being long. "Dog" is a bad card — "it says woof" ends it instantly. "Volcano"
  is a great one, because every natural way to say it ("mountain", "erupt",
  "lava") is illegal and the giver has to fight for it.

  Rules for anything added here:
    - known to a US/UK teenager. No regional food, no British-only slang.
    - spelled the way the larger audience types it. Guessing is exact-match and
      the normaliser does not merge US and UK spellings, so a card reading
      "Harbour" scored a US player's "harbor" as WRONG — the game visibly
      refusing a correct answer. US traffic is 35% of the site and UK 14%.
    - ONE word. Guessing is exact-match through the shared answer normaliser,
      and phrases make that a coin flip.
    - concrete. Abstract nouns ("justice") produce clue-giving that is no fun to
      watch and impossible to guess.
    - NOT judged on its own syllable count. "Ghost" and "Witch" are one syllable
      and are excellent cards, because the giver may never say the answer at any
      length — the constraint is on the CLUES, not on the word. Worth stating
      because the opposite seems obvious and is wrong.

  Sized per TESTING.md §4: at most 8 rounds plus skips, budget 16 per game, so
  the floor is 2 x 16 / 0.75 = 43. This is well past that so two back-to-back
  games barely overlap.
*/

const WORDS = [
  // Animals — the easiest category to guess and the best warm-up
  'Elephant', 'Giraffe', 'Penguin', 'Octopus', 'Dolphin', 'Kangaroo', 'Squirrel',
  'Butterfly', 'Rhinoceros', 'Hippopotamus', 'Crocodile', 'Flamingo', 'Panda',
  'Gorilla', 'Cheetah', 'Camel', 'Donkey', 'Lobster', 'Jellyfish', 'Spider',
  'Hamster', 'Rabbit', 'Turtle', 'Peacock', 'Parrot', 'Beaver', 'Badger',
  'Hedgehog', 'Walrus', 'Raccoon', 'Ostrich', 'Vulture', 'Scorpion', 'Chicken',
  'Monkey', 'Tiger', 'Lion', 'Zebra', 'Koala', 'Sloth', 'Otter', 'Weasel',

  // Everyday objects — the sweet spot for this game
  'Umbrella', 'Sunglasses', 'Toothbrush', 'Hairbrush', 'Scissors', 'Hammer',
  'Ladder', 'Bicycle', 'Helicopter', 'Airplane', 'Tractor', 'Ambulance',
  'Toaster', 'Blender', 'Kettle', 'Microwave', 'Fridge', 'Vacuum', 'Mirror',
  'Pillow', 'Blanket', 'Curtain', 'Carpet', 'Wallet', 'Suitcase', 'Backpack',
  'Necklace', 'Bracelet', 'Earring', 'Helmet', 'Goggles', 'Whistle', 'Compass',
  'Telescope', 'Camera', 'Printer', 'Keyboard', 'Battery', 'Charger', 'Speaker',
  'Candle', 'Lantern', 'Bucket', 'Shovel', 'Anchor', 'Paddle', 'Trumpet',
  'Guitar', 'Piano', 'Violin', 'Drumkit', 'Balloon', 'Kazoo',

  // Food and drink
  'Pizza', 'Banana', 'Pineapple', 'Strawberry', 'Avocado', 'Broccoli', 'Carrot',
  'Potato', 'Tomato', 'Cucumber', 'Spaghetti', 'Sandwich', 'Pancake', 'Waffle',
  'Popcorn', 'Chocolate', 'Cookie', 'Donut', 'Muffin', 'Yogurt', 'Cereal',
  'Burrito', 'Noodle', 'Pretzel', 'Lemonade', 'Coffee', 'Butter', 'Honey',
  'Ketchup', 'Mustard', 'Pepper', 'Lettuce', 'Onion', 'Garlic', 'Mushroom',
  'Coconut', 'Cherry', 'Melon', 'Apple', 'Orange', 'Lemon', 'Peanut',

  // Places and buildings
  'Volcano', 'Island', 'Desert', 'Jungle', 'Mountain', 'River', 'Ocean',
  'Castle', 'Palace', 'Cottage', 'Stadium', 'Airport', 'Station', 'Library',
  'Museum', 'Hospital', 'Prison', 'Bakery', 'Market', 'Harbor', 'Village',
  'City', 'Tunnel', 'Bridge', 'Lighthouse', 'Windmill', 'Pyramid', 'Igloo',
  'Cabin', 'Garden', 'Forest', 'Meadow', 'Canyon', 'Glacier', 'Waterfall',

  // People and jobs
  'Doctor', 'Teacher', 'Farmer', 'Pilot', 'Sailor', 'Soldier', 'Painter',
  'Singer', 'Dancer', 'Writer', 'Baker', 'Butcher', 'Barber', 'Plumber',
  'Builder', 'Driver', 'Waiter', 'Dentist', 'Nurse', 'Lawyer', 'Actor',
  'Astronaut', 'Scientist', 'Detective', 'Referee', 'Wizard', 'Pirate',
  'Cowboy', 'Ninja', 'Robot', 'Vampire', 'Zombie', 'Mermaid', 'Dragon',

  // Weather and nature
  'Rainbow', 'Thunder', 'Lightning', 'Tornado', 'Blizzard', 'Sunset', 'Sunrise',
  'Shadow', 'Puddle', 'Iceberg', 'Cactus', 'Bamboo', 'Acorn', 'Feather',
  'Pebble', 'Seashell', 'Coral', 'Fossil', 'Diamond', 'Crystal', 'Magnet',

  // Sport and play
  'Football', 'Baseball', 'Tennis', 'Bowling', 'Boxing', 'Skiing', 'Surfing',
  'Skateboard', 'Trampoline', 'Playground', 'Puzzle', 'Marbles', 'Frisbee',
  'Whistle', 'Trophy', 'Medal', 'Racket', 'Goalie', 'Referee',

  // Body and health
  'Elbow', 'Shoulder', 'Ankle', 'Stomach', 'Eyebrow', 'Fingernail', 'Freckle',
  'Muscle', 'Sneeze', 'Hiccup', 'Yawn', 'Shiver', 'Bandage', 'Crutches',

  // Around the house
  'Chimney', 'Doorbell', 'Mailbox', 'Staircase', 'Basement', 'Balcony',
  'Wardrobe', 'Cupboard', 'Drawer', 'Faucet', 'Shower', 'Bathtub', 'Toilet',
  'Laundry', 'Dishwasher', 'Cushion', 'Wallpaper', 'Radiator',

  // Things that happen
  'Birthday', 'Wedding', 'Funeral', 'Holiday', 'Parade', 'Circus', 'Concert',
  'Festival', 'Picnic', 'Camping', 'Fishing', 'Shopping', 'Haircut', 'Nightmare',
  'Whisper', 'Giggle', 'Argument', 'Promise', 'Secret', 'Rumor', 'Journey',

  // Recognisable one-offs, the ones that produce the best clues
  'Dinosaur', 'Skeleton', 'Mummy', 'Ghost', 'Witch', 'Alien', 'Rocket',
  'Satellite', 'Planet', 'Meteor', 'Galaxy', 'Submarine', 'Treasure', 'Compass',
  'Password', 'Selfie', 'Emoji', 'Podcast', 'Wifi', 'Alarm', 'Calendar',
  'Envelope', 'Postcard', 'Newspaper', 'Magazine', 'Dictionary', 'Passport',
  'Ticket', 'Receipt', 'Trolley', 'Escalator', 'Elevator',
];

/* Duplicates are easy to introduce by hand and impossible to see by eye —
   'Compass', 'Whistle' and 'Referee' each appear in two categories above
   because they genuinely fit both. Collapse them once, here, rather than
   letting a deck deal the same card twice in one game. */
const UNIQUE = [...new Set(WORDS)];

export const CAVEMAN_WORDS = UNIQUE;

/** Fisher-Yates, so a deck is dealt without repeats within a game. */
export function shuffledDeck() {
  const deck = [...UNIQUE];
  for (let i = deck.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}
