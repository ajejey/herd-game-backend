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

  SIZE, and why it is not the whole answer.

  TESTING.md §4 puts the floor at 43: at most 8 rounds plus skips is a budget of
  16 cards a game, doubled and divided by 0.75. The bank is far past that, so
  nothing repeats inside a game — a full shuffle is dealt from the top and the
  deck is walked, never reset.

  Across games it used to repeat anyway, and the arithmetic is worth writing
  down because it is not obvious. At 328 words, two games back to back shared
  0.78 cards on average and there was a 56% chance the second game showed a word
  from the first. A visitor never notices. The host who runs it every Friday —
  the only person whose opinion moves the numbers — notices immediately.

  Two things fixed it. The bank roughly doubled, which moves every number above
  by the same factor. And shuffledDeck now takes the words the host's browser
  has already been dealt and puts them at the BACK of the deck rather than
  dropping them, so a repeat host walks the whole bank before anything comes
  round again, and a host who has somehow seen all of it still gets a full-
  length game. See frontend/src/lib/recentWords.js.
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

  // More animals
  'Buffalo', 'Pelican', 'Seagull', 'Sparrow', 'Woodpecker', 'Falcon', 'Panther',
  'Leopard', 'Antelope', 'Gazelle', 'Bison', 'Reindeer', 'Moose', 'Ferret',
  'Chipmunk', 'Porcupine', 'Armadillo', 'Anteater', 'Meerkat', 'Lemur', 'Baboon',
  'Orangutan', 'Platypus', 'Wombat', 'Dingo', 'Cobra', 'Python', 'Iguana',
  'Salamander', 'Tadpole', 'Starfish', 'Seahorse', 'Stingray', 'Swordfish', 'Barnacle',
  'Termite', 'Mosquito', 'Grasshopper', 'Dragonfly', 'Caterpillar', 'Earthworm',
  'Snail', 'Beetle', 'Firefly', 'Hornet', 'Tarantula', 'Buzzard', 'Magpie',
  'Puffin',

  // More things you can hold
  'Stapler', 'Calculator', 'Binoculars', 'Microscope', 'Stopwatch', 'Thermometer', 'Corkscrew',
  'Tweezers', 'Screwdriver', 'Wrench', 'Chisel', 'Sandpaper', 'Doorknob', 'Padlock',
  'Zipper', 'Buckle', 'Shoelace', 'Raincoat', 'Mitten', 'Slipper', 'Sandal',
  'Apron', 'Scarf', 'Sunscreen', 'Toothpaste', 'Shampoo', 'Perfume', 'Lipstick',
  'Hairdryer', 'Razor', 'Comb', 'Sponge', 'Broom', 'Dustpan', 'Wheelbarrow',
  'Sprinkler', 'Birdhouse', 'Scarecrow', 'Beehive', 'Hammock', 'Matchbox', 'Firework',
  'Sparkler', 'Chandelier', 'Hourglass', 'Sundial', 'Metronome', 'Kaleidoscope', 'Periscope',
  'Typewriter', 'Monocle', 'Tuxedo', 'Kimono', 'Poncho', 'Turban',
  'Beret', 'Sombrero', 'Tiara', 'Ribbon',

  // More food and drink
  'Croissant', 'Bagel', 'Pudding', 'Custard', 'Marshmallow', 'Caramel', 'Toffee',
  'Cupcake', 'Brownie', 'Pastry', 'Cracker', 'Oatmeal',
  'Granola', 'Smoothie', 'Milkshake', 'Sundae', 'Cabbage', 'Cauliflower', 'Celery',
  'Spinach', 'Radish', 'Turnip', 'Pumpkin', 'Asparagus', 'Artichoke', 'Lentil',
  'Chickpea', 'Almond', 'Cashew', 'Walnut', 'Pistachio', 'Raisin', 'Apricot',
  'Peach', 'Plum', 'Mango', 'Papaya', 'Grapefruit', 'Blueberry', 'Raspberry',
  'Blackberry', 'Cranberry', 'Watermelon', 'Vinegar', 'Cinnamon', 'Parsley', 'Sausage',
  'Bacon', 'Meatball', 'Dumpling', 'Taco', 'Lasagna', 'Ravioli', 'Sushi',
  'Curry', 'Falafel', 'Hummus', 'Pickle', 'Olive', 'Syrup', 'Gravy',
  'Sorbet',

  // More places
  'Cathedral', 'Chapel', 'Temple', 'Monastery', 'Skyscraper', 'Warehouse', 'Factory',
  'Mansion', 'Bungalow', 'Attic', 'Cellar', 'Corridor', 'Courtyard', 'Driveway',
  'Highway', 'Runway', 'Platform', 'Terminal', 'Shipyard', 'Quarry',
  'Vineyard', 'Orchard', 'Greenhouse', 'Stable', 'Kennel', 'Aquarium', 'Planetarium',
  'Observatory', 'Casino', 'Arcade', 'Campsite', 'Cemetery', 'Swamp',
  'Lagoon', 'Cliff', 'Cave', 'Valley', 'Prairie', 'Tundra',
  'Oasis', 'Crater', 'Geyser', 'Avalanche', 'Whirlpool', 'Peninsula', 'Fjord',
  'Reef',

  // More people
  'Librarian', 'Mechanic', 'Electrician', 'Carpenter', 'Blacksmith', 'Locksmith', 'Janitor',
  'Gardener', 'Shepherd', 'Hunter', 'Miner', 'Sculptor', 'Photographer', 'Journalist',
  'Architect', 'Engineer', 'Surgeon', 'Pharmacist', 'Professor', 'Principal', 'Coach',
  'Lifeguard', 'Firefighter', 'Paramedic', 'Bodyguard', 'Butler', 'Nanny',
  'Cashier', 'Bartender', 'Tailor', 'Magician', 'Juggler', 'Acrobat', 'Puppeteer',
  'Ventriloquist', 'Comedian', 'Drummer', 'Conductor', 'Composer', 'Poet', 'Historian',
  'Archaeologist', 'Astronomer', 'Inventor', 'Explorer', 'Knight', 'Samurai', 'Viking',
  'Gladiator', 'Emperor', 'Peasant', 'Hermit', 'Nomad', 'Smuggler', 'Burglar',
  'Bandit', 'Outlaw', 'Sheriff', 'Werewolf', 'Goblin', 'Troll', 'Unicorn',
  'Phoenix', 'Minotaur', 'Genie', 'Yeti',

  // More weather and nature
  'Hurricane', 'Monsoon', 'Drought', 'Hailstone', 'Snowflake', 'Icicle',
  'Drizzle', 'Downpour', 'Eclipse', 'Aurora', 'Comet', 'Asteroid',
  'Constellation', 'Moonlight', 'Twilight', 'Horizon', 'Mirage', 'Quicksand', 'Landslide',
  'Earthquake', 'Tsunami', 'Wildfire', 'Ember', 'Pollen', 'Nectar', 'Sapling',
  'Fern', 'Thistle', 'Daisy', 'Tulip', 'Sunflower', 'Orchid', 'Dandelion',
  'Mistletoe', 'Pinecone', 'Chestnut', 'Maple', 'Willow',

  // More sport and play
  'Badminton', 'Volleyball', 'Basketball', 'Hockey', 'Rugby', 'Archery', 'Fencing',
  'Gymnastics', 'Wrestling', 'Karate', 'Marathon', 'Triathlon', 'Hurdles', 'Javelin',
  'Snorkel', 'Kayak', 'Canoe', 'Sailboat', 'Snowboard', 'Dominoes',
  'Chess', 'Backgammon', 'Bingo', 'Charades', 'Dartboard', 'Pinball',
  'Joystick', 'Hopscotch',

  // More body and health
  'Knuckle', 'Kneecap', 'Wrist', 'Thumb', 'Ribcage', 'Kidney', 'Nostril',
  'Earlobe', 'Dimple', 'Wrinkle', 'Blister', 'Bruise', 'Splinter', 'Sunburn',
  'Allergy', 'Snore', 'Goosebumps', 'Wheelchair', 'Stethoscope', 'Syringe', 'Ointment',

  // More around the house
  'Fireplace', 'Doorstep', 'Skylight', 'Windowsill', 'Floorboard', 'Rooftop', 'Gutter',
  'Drainpipe', 'Porch', 'Patio', 'Pantry', 'Saucepan', 'Colander',
  'Whisk', 'Spatula', 'Bookshelf', 'Footstool', 'Dresser', 'Keyhole',
  'Latch', 'Hinge', 'Intercom', 'Thermostat',

  // More things that happen
  'Anniversary', 'Graduation', 'Reunion', 'Rehearsal', 'Audition', 'Ceremony', 'Carnival',
  'Fundraiser', 'Auction', 'Election', 'Coronation', 'Honeymoon', 'Sleepover', 'Barbecue',
  'Banquet', 'Applause', 'Encore', 'Intermission', 'Countdown', 'Blackout', 'Detour',
  'Stampede',

  // More one-offs
  'Gramophone', 'Accordion', 'Harmonica', 'Saxophone', 'Trombone', 'Tambourine', 'Xylophone',
  'Bagpipes', 'Ukulele', 'Banjo', 'Cello', 'Cymbal', 'Marionette', 'Origami',
  'Mosaic', 'Graffiti', 'Tattoo', 'Sculpture', 'Easel', 'Canvas',
  'Anvil', 'Weathervane', 'Flagpole', 'Turnstile', 'Shield', 'Dagger', 'Crossbow',
  'Catapult', 'Cannon', 'Torpedo', 'Parachute', 'Glider', 'Zeppelin', 'Hovercraft',
  'Bulldozer', 'Forklift', 'Trailer', 'Motorbike', 'Scooter', 'Unicycle',
  'Rickshaw', 'Gondola', 'Yacht', 'Lifeboat', 'Rollercoaster', 'Carousel', 'Confetti',
  'Bouquet', 'Wreath', 'Garland', 'Ornament', 'Tinsel', 'Sleigh', 'Snowman',
  'Gingerbread', 'Nutcracker', 'Costume', 'Broomstick', 'Cauldron', 'Potion', 'Amulet',
  'Scroll', 'Papyrus', 'Sarcophagus', 'Obelisk', 'Aqueduct', 'Labyrinth', 'Tapestry',
  'Portrait', 'Treadmill', 'Turbine', 'Windsock',
];

/* Duplicates are easy to introduce by hand and impossible to see by eye —
   'Compass', 'Whistle' and 'Referee' each appear in two categories above
   because they genuinely fit both. Collapse them once, here, rather than
   letting a deck deal the same card twice in one game. */
const UNIQUE = [...new Set(WORDS)];

export const CAVEMAN_WORDS = UNIQUE;

/*
  The list BEFORE deduplication, and the handful of repeats that are deliberate.

  Exported because the guard that exists to catch an accidental duplicate was
  reading CAVEMAN_WORDS — which is the deduplicated array, so its duplicate
  count is structurally always zero. It could never fire, on the one bank most
  likely to grow by hand: ~500 words were added to it in a single sitting.

  Reading the raw list instead makes the check real, and the three below are
  named so an accidental fourth stands out instead of being lost in a count.
*/
export const CAVEMAN_WORDS_RAW = WORDS;
export const INTENTIONAL_DUPES = ['Compass', 'Whistle', 'Referee'];

/** Fisher-Yates. Mutates and returns the array it is given. */
function shuffle(list) {
  for (let i = list.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

/* Same shape of key the client uses, so "Harbor" and "harbor " are one word. */
const key = (w) => String(w || '').trim().toLowerCase();

/**
 * A shuffled deck, with anything in `exclude` pushed to the BACK rather than
 * dropped.
 *
 * A deck is dealt from the top and never repeats within a game — that part was
 * always true. What this adds is across games: the host's browser sends the
 * words it has already been dealt (see frontend/src/lib/recentWords.js), and
 * those go last, so a repeat visitor walks the whole bank before anything comes
 * round again.
 *
 * Pushed to the back and NOT filtered out, deliberately. Filtering means a host
 * who has seen 320 of the 328 words gets an eight-card deck and a game that
 * ends after two rounds — the fix would have broken the game for exactly the
 * people it exists to serve. Ordering cannot: the deck is always the full bank,
 * so `totalTurns` still has everything it needs and the worst case is simply
 * the old behaviour.
 */
export function shuffledDeck(exclude = []) {
  const seen = new Set((Array.isArray(exclude) ? exclude : []).map(key));
  if (!seen.size) return shuffle([...UNIQUE]);
  const fresh = [];
  const stale = [];
  for (const w of UNIQUE) (seen.has(key(w)) ? stale : fresh).push(w);
  return [...shuffle(fresh), ...shuffle(stale)];
}
