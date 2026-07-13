export const OPENAI_ECONOMY_POLICY = Object.freeze({
  contextualResponse: {
    defaultOutputTokens: 140,
    complexOutputTokens: 190,
    recentMessages: 5,
    messageCharacters: 360,
    knowledgeArticles: 3,
    knowledgeCharacters: 650
  },
  contextualDecision: {
    maxOutputTokens: 200,
    recentMessages: 5,
    messageCharacters: 360,
    knowledgeArticles: 3,
    knowledgeCharacters: 650
  },
  intent: {
    maxOutputTokens: 70,
    messageCharacters: 450
  },
  salesResponse: {
    defaultOutputTokens: 70,
    commercialOutputTokens: 100,
    technicalOutputTokens: 130,
    recentMessages: 5,
    messageCharacters: 360,
    knowledgeArticles: 3,
    knowledgeCharacters: 650
  },
  specialistAnalysis: {
    maxOutputTokens: 160
  },
  dailyLearning: {
    maxOutputTokens: 260,
    maxExamples: 6,
    maxDirectives: 3
  }
});
