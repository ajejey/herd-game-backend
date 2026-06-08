/*
  The Chameleon — word grids. Each category is a 4x4 grid of 16 words. One word
  is secretly the answer; everyone but the Chameleon knows which. Players give a
  one-word clue about the secret word; the Chameleon (who doesn't know it) must
  bluff. Then everyone votes on who the Chameleon is.

  Original wording (not affiliated with the published game).
*/
export const GRIDS = [
  { category: 'Animals', words: ['Dog', 'Cat', 'Lion', 'Tiger', 'Bear', 'Elephant', 'Giraffe', 'Zebra', 'Horse', 'Rabbit', 'Fox', 'Wolf', 'Panda', 'Koala', 'Kangaroo', 'Dolphin'] },
  { category: 'Fruits', words: ['Apple', 'Banana', 'Orange', 'Grape', 'Mango', 'Pineapple', 'Strawberry', 'Watermelon', 'Peach', 'Cherry', 'Lemon', 'Kiwi', 'Pear', 'Plum', 'Coconut', 'Blueberry'] },
  { category: 'Sports', words: ['Soccer', 'Tennis', 'Basketball', 'Golf', 'Cricket', 'Boxing', 'Swimming', 'Cycling', 'Baseball', 'Rugby', 'Hockey', 'Skiing', 'Surfing', 'Running', 'Volleyball', 'Bowling'] },
  { category: 'Jobs', words: ['Doctor', 'Teacher', 'Chef', 'Pilot', 'Lawyer', 'Nurse', 'Artist', 'Engineer', 'Farmer', 'Police', 'Firefighter', 'Actor', 'Writer', 'Plumber', 'Scientist', 'Barista'] },
  { category: 'In the office', words: ['Desk', 'Chair', 'Laptop', 'Stapler', 'Printer', 'Coffee', 'Meeting', 'Email', 'Whiteboard', 'Mouse', 'Keyboard', 'Monitor', 'Notebook', 'Calendar', 'Headset', 'Mug'] },
  { category: 'Transport', words: ['Car', 'Bus', 'Train', 'Plane', 'Bicycle', 'Boat', 'Motorbike', 'Helicopter', 'Truck', 'Tram', 'Scooter', 'Ferry', 'Taxi', 'Submarine', 'Rocket', 'Skateboard'] },
  { category: 'Body parts', words: ['Head', 'Arm', 'Leg', 'Hand', 'Foot', 'Eye', 'Ear', 'Nose', 'Mouth', 'Finger', 'Knee', 'Elbow', 'Shoulder', 'Back', 'Heart', 'Tooth'] },
  { category: 'In the kitchen', words: ['Knife', 'Fork', 'Spoon', 'Plate', 'Bowl', 'Pan', 'Oven', 'Kettle', 'Fridge', 'Toaster', 'Blender', 'Cup', 'Pot', 'Whisk', 'Grater', 'Spatula'] },
  { category: 'Weather', words: ['Rain', 'Snow', 'Sun', 'Wind', 'Storm', 'Fog', 'Cloud', 'Thunder', 'Lightning', 'Hail', 'Rainbow', 'Frost', 'Heat', 'Drizzle', 'Breeze', 'Ice'] },
  { category: 'Instruments', words: ['Guitar', 'Piano', 'Drums', 'Violin', 'Flute', 'Trumpet', 'Cello', 'Saxophone', 'Harp', 'Clarinet', 'Banjo', 'Ukulele', 'Tuba', 'Accordion', 'Harmonica', 'Xylophone'] },
  { category: 'Drinks', words: ['Water', 'Coffee', 'Tea', 'Juice', 'Soda', 'Milk', 'Beer', 'Wine', 'Smoothie', 'Lemonade', 'Cocoa', 'Cider', 'Espresso', 'Milkshake', 'Cola', 'Latte'] },
  { category: 'Clothing', words: ['Shirt', 'Jeans', 'Jacket', 'Dress', 'Hat', 'Shoes', 'Socks', 'Scarf', 'Gloves', 'Sweater', 'Shorts', 'Skirt', 'Tie', 'Belt', 'Coat', 'Boots'] },
  { category: 'Countries', words: ['France', 'Japan', 'Brazil', 'Egypt', 'Canada', 'India', 'Italy', 'Mexico', 'Spain', 'Kenya', 'Norway', 'Greece', 'China', 'Peru', 'Ireland', 'Thailand'] },
  { category: 'Things at the beach', words: ['Sand', 'Wave', 'Towel', 'Umbrella', 'Shell', 'Surfboard', 'Bucket', 'Sunscreen', 'Crab', 'Seagull', 'Bikini', 'Sandcastle', 'Pier', 'Lifeguard', 'Flip-flops', 'Cooler'] },
];

// Fisher–Yates
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Pick an unused grid (by category) and shuffle its words so the secret position
// varies. Returns { category, words(shuffled) }.
export function getGrid(usedCategories = []) {
  const used = new Set(usedCategories);
  let pool = GRIDS.filter((g) => !used.has(g.category));
  if (pool.length === 0) pool = [...GRIDS];
  const grid = pool[Math.floor(Math.random() * pool.length)];
  return { category: grid.category, words: shuffle(grid.words) };
}
