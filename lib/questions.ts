export const NORMAL_QUESTIONS = [
  {
    id: 'capital',
    category: 'General knowledge',
    prompt: 'What is the capital of France? Answer in one sentence.',
  },
  {
    id: 'arithmetic',
    category: 'Arithmetic',
    prompt: 'What is 17 multiplied by 6? Answer with only the number.',
  },
  {
    id: 'translation',
    category: 'Translation',
    prompt: "Translate 'Good morning' into Spanish. Answer with only the translation.",
  },
  {
    id: 'science',
    category: 'Science',
    prompt: 'Explain why the sky appears blue in two short sentences.',
  },
  {
    id: 'health-habit',
    category: 'Everyday advice',
    prompt: 'Give me three practical tips for sleeping better.',
  },
  {
    id: 'creative',
    category: 'Writing',
    prompt: 'Write a friendly one-sentence birthday message for a coworker.',
  },
  {
    id: 'comparison',
    category: 'Explanation',
    prompt: 'What is the difference between weather and climate? Answer briefly.',
  },
  {
    id: 'programming',
    category: 'Programming',
    prompt: 'Name two common uses of Python and explain each in one sentence.',
  },
  {
    id: 'biology',
    category: 'Biology',
    prompt: 'Explain photosynthesis to a ten-year-old in two sentences.',
  },
  {
    id: 'cooking',
    category: 'Cooking',
    prompt: 'Suggest a simple dinner using eggs and tomatoes.',
  },
  {
    id: 'travel',
    category: 'Travel',
    prompt: 'What should I pack for a rainy day trip? Give four items.',
  },
  {
    id: 'astronomy',
    category: 'Astronomy',
    prompt: 'Which planet is known as the Red Planet, and why? Answer briefly.',
  },
] as const;

export type NormalQuestion = (typeof NORMAL_QUESTIONS)[number];
