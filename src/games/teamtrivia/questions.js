/*
  Team Trivia — multiple-choice question bank (server-side, authoritative).
  Each question: { q, options: [CORRECT, wrong, wrong, wrong], category }.
  The correct answer is authored FIRST; option order is shuffled per round in
  game.js so the correct one isn't always position A.

  v1 is a curated, high-confidence set. Later: expand from Open Trivia DB
  (same pipeline as Daily Trivia) — see GAMES_ROADMAP.md / TRIVIA_GAME_VISION.md.
*/
export const QUESTIONS = [
  { q: 'What is the capital of Australia?', options: ['Canberra', 'Sydney', 'Melbourne', 'Perth'], category: 'Geography' },
  { q: 'Which is the largest ocean on Earth?', options: ['Pacific', 'Atlantic', 'Indian', 'Arctic'], category: 'Geography' },
  { q: 'What is the longest river in the world?', options: ['Nile', 'Amazon', 'Yangtze', 'Mississippi'], category: 'Geography' },
  { q: 'The Eiffel Tower is in which city?', options: ['Paris', 'Rome', 'London', 'Berlin'], category: 'Geography' },
  { q: 'Which country has the most natural lakes?', options: ['Canada', 'Russia', 'USA', 'Finland'], category: 'Geography' },
  { q: 'What is the smallest country in the world by area?', options: ['Vatican City', 'Monaco', 'Malta', 'San Marino'], category: 'Geography' },
  { q: 'Mount Everest lies on the border of Nepal and which country?', options: ['China', 'India', 'Bhutan', 'Pakistan'], category: 'Geography' },

  { q: 'What gas do plants absorb for photosynthesis?', options: ['Carbon dioxide', 'Oxygen', 'Nitrogen', 'Hydrogen'], category: 'Science' },
  { q: 'How many bones are in the adult human body?', options: ['206', '186', '226', '306'], category: 'Science' },
  { q: 'What is the chemical symbol for gold?', options: ['Au', 'Ag', 'Gd', 'Go'], category: 'Science' },
  { q: 'Which planet is the hottest in our solar system?', options: ['Venus', 'Mercury', 'Mars', 'Jupiter'], category: 'Science' },
  { q: 'What is the most abundant gas in Earth’s atmosphere?', options: ['Nitrogen', 'Oxygen', 'Carbon dioxide', 'Argon'], category: 'Science' },
  { q: 'What part of the cell is its powerhouse?', options: ['Mitochondria', 'Nucleus', 'Ribosome', 'Membrane'], category: 'Science' },
  { q: 'What force pulls objects toward Earth?', options: ['Gravity', 'Magnetism', 'Friction', 'Inertia'], category: 'Science' },
  { q: 'Which blood type is the universal donor?', options: ['O negative', 'AB positive', 'A positive', 'B negative'], category: 'Science' },

  { q: 'In which year did World War II end?', options: ['1945', '1944', '1939', '1948'], category: 'History' },
  { q: 'Who was the first President of the United States?', options: ['George Washington', 'Thomas Jefferson', 'Abraham Lincoln', 'John Adams'], category: 'History' },
  { q: 'Who painted the Mona Lisa?', options: ['Leonardo da Vinci', 'Michelangelo', 'Raphael', 'Van Gogh'], category: 'History' },
  { q: 'The Titanic sank in which year?', options: ['1912', '1905', '1920', '1898'], category: 'History' },
  { q: 'Which country gifted the Statue of Liberty to the USA?', options: ['France', 'Britain', 'Spain', 'Italy'], category: 'History' },
  { q: 'Who developed the theory of relativity?', options: ['Albert Einstein', 'Isaac Newton', 'Galileo', 'Nikola Tesla'], category: 'History' },

  { q: 'How many players are on a soccer team on the field?', options: ['11', '10', '9', '12'], category: 'Sport' },
  { q: 'In tennis, what is a score of zero called?', options: ['Love', 'Nil', 'Duck', 'Blank'], category: 'Sport' },
  { q: 'How often are the Summer Olympic Games held?', options: ['Every 4 years', 'Every 2 years', 'Every 3 years', 'Every 5 years'], category: 'Sport' },
  { q: 'Which country has won the most men’s FIFA World Cups?', options: ['Brazil', 'Germany', 'Italy', 'Argentina'], category: 'Sport' },
  { q: 'How many points is a touchdown worth in American football?', options: ['6', '7', '3', '5'], category: 'Sport' },

  { q: 'In which fictional city does Batman operate?', options: ['Gotham City', 'Metropolis', 'Star City', 'Central City'], category: 'Entertainment' },
  { q: 'Which band performed "Hey Jude"?', options: ['The Beatles', 'The Rolling Stones', 'Queen', 'The Who'], category: 'Entertainment' },
  { q: 'What kind of animal is Pumbaa in The Lion King?', options: ['Warthog', 'Meerkat', 'Lion', 'Hyena'], category: 'Entertainment' },
  { q: 'In Frozen, what is the name of the snowman?', options: ['Olaf', 'Sven', 'Kristoff', 'Hans'], category: 'Entertainment' },
  { q: 'Who wrote the "Harry Potter" series?', options: ['J.K. Rowling', 'Stephen King', 'J.R.R. Tolkien', 'Roald Dahl'], category: 'Entertainment' },
  { q: 'Which streaming show features the "Upside Down"?', options: ['Stranger Things', 'The Crown', 'Wednesday', 'Dark'], category: 'Entertainment' },

  { q: 'Which fruit is traditionally used to make wine?', options: ['Grapes', 'Apples', 'Berries', 'Plums'], category: 'Food' },
  { q: 'What is the main ingredient in guacamole?', options: ['Avocado', 'Tomato', 'Pea', 'Cucumber'], category: 'Food' },
  { q: 'Which country is the origin of sushi?', options: ['Japan', 'China', 'Korea', 'Thailand'], category: 'Food' },
  { q: 'Espresso originates from which country?', options: ['Italy', 'France', 'Brazil', 'Colombia'], category: 'Food' },
  { q: 'What spice is the most expensive by weight?', options: ['Saffron', 'Vanilla', 'Cardamom', 'Cinnamon'], category: 'Food' },

  { q: 'How many continents are there on Earth?', options: ['7', '5', '6', '8'], category: 'General' },
  { q: 'What is the largest mammal in the world?', options: ['Blue whale', 'African elephant', 'Giraffe', 'Hippopotamus'], category: 'General' },
  { q: 'How many sides does a hexagon have?', options: ['6', '5', '7', '8'], category: 'General' },
  { q: 'What is the smallest prime number?', options: ['2', '1', '3', '0'], category: 'General' },
  { q: 'Which language has the most native speakers worldwide?', options: ['Mandarin Chinese', 'English', 'Spanish', 'Hindi'], category: 'General' },
  { q: 'What colour do you get mixing blue and yellow?', options: ['Green', 'Purple', 'Orange', 'Brown'], category: 'General' },
  { q: 'How many minutes are in a full day?', options: ['1440', '1240', '720', '2400'], category: 'General' },
  { q: 'What is the currency used in Japan?', options: ['Yen', 'Won', 'Yuan', 'Ringgit'], category: 'General' },
  { q: 'Which is the tallest land animal?', options: ['Giraffe', 'Elephant', 'Horse', 'Camel'], category: 'General' },
  { q: 'How many colours are there in a rainbow?', options: ['7', '6', '5', '8'], category: 'General' },
];

// Pick n unused questions at random; recycle if the bank is exhausted.
export function getRandomQuestions(n, usedQ = [], custom = null) {
  const bank = Array.isArray(custom) && custom.length ? custom : QUESTIONS;
  const used = new Set(usedQ);
  let pool = bank.filter((q) => !used.has(q.q));
  if (pool.length < n) pool = [...bank]; // recycle
  // Fisher–Yates
  const a = [...pool];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}
