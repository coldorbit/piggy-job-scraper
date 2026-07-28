import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AI_ML_JOB_SEARCHES,
  aiMlAreaForJob,
  filterAiMlJobs,
  isAiMlJob,
  roleFamilyForJob,
  tagJobRoleFamily,
} from '../sites/lib/jobFilters.js';

const specialtyCases = [
  ['We build computer vision and object detection models.', 'computer_vision'],
  ['Develop natural language processing and information extraction models.', 'nlp'],
  ['Train speech recognition and audio models.', 'speech_audio_ml'],
  ['Improve our recommendation systems and personalization models.', 'recommendation_systems'],
  ['Own time-series forecasting and demand prediction models.', 'time_series_forecasting'],
  ['Build fraud detection and financial crime models.', 'anomaly_fraud_detection'],
  ['Develop graph neural networks and knowledge graph models.', 'graph_ml'],
  ['Create robotics control systems and motion-planning models.', 'robotics_control'],
  ['Build generative AI applications using large language models.', 'generative_ai'],
  ['Train multimodal models across vision and natural language processing.', 'multimodal_ml'],
  ['Build tabular data models with XGBoost and LightGBM.', 'tabular_ml'],
];

test('classifies AI/ML areas from descriptions behind generic titles', () => {
  for (const [description, expected] of specialtyCases) {
    const job = { title: 'Machine Learning Engineer', description };
    assert.equal(aiMlAreaForJob(job), expected, description);
    assert.equal(roleFamilyForJob(job), 'ml_engineer', description);
  }
});

test('description evidence determines area independently of role type', () => {
  const description =
    'Own our recommendation systems, recommender evaluation, and personalization models.';

  assert.equal(
    aiMlAreaForJob({ title: 'NLP Scientist', description }),
    'recommendation_systems',
  );
  assert.equal(
    aiMlAreaForJob({ title: 'Applied Scientist', description }),
    'recommendation_systems',
  );
});

test('a clear description classifies area even when the title has no AI/ML keyword', () => {
  const job = {
    title: 'Research Engineer',
    description: 'Develop anomaly detection and outlier detection models for financial transactions.',
  };
  assert.equal(aiMlAreaForJob(job), 'anomaly_fraud_detection');
  assert.equal(roleFamilyForJob(job), 'ml_engineer');
});

test('uses listingText when a dedicated description field is unavailable', () => {
  const job = {
    title: 'Applied Scientist',
    listingText: 'Develop graph machine learning models using graph neural networks.',
  };
  assert.equal(aiMlAreaForJob(job), 'graph_ml');
  assert.equal(roleFamilyForJob(job), 'applied_scientist');
});

test('uses repeated description evidence to resolve the dominant area', () => {
  assert.equal(
    aiMlAreaForJob({
      title: 'Research Scientist',
      description:
        'Build recommendation systems and recommender models. Improve personalization. Collaborate once with the NLP team.',
    }),
    'recommendation_systems',
  );
});

test('uses a single specialty search only as an area fallback for a qualifying AI/ML job', () => {
  const job = {
    title: 'Machine Learning Engineer',
    sourceUrl: 'https://example.com/jobs?q=recommendation+systems',
  };
  assert.equal(aiMlAreaForJob(job), 'recommendation_systems');
  assert.equal(roleFamilyForJob(job), 'ml_engineer');
});

test('does not treat an AI/ML search URL as evidence that an unrelated result is AI/ML', () => {
  const job = {
    title: 'Backend Software Engineer',
    description: 'Build REST APIs and payment services with Node.js and PostgreSQL.',
    sourceUrl: 'https://example.com/jobs?q=machine+learning+engineer',
  };

  assert.equal(isAiMlJob(job), false);
  assert.equal(aiMlAreaForJob(job), '');
  assert.equal(roleFamilyForJob(job), 'software');
});

test('filters scraped results to jobs with AI/ML evidence in the job itself', () => {
  const jobs = [
    {
      title: 'Research Engineer',
      description: 'Develop anomaly detection and outlier detection models for transactions.',
    },
    { title: 'Computer Vision Engineer' },
    {
      title: 'Data Engineer',
      jobCategory: 'Artificial Intelligence',
      description: 'Build ETL pipelines and maintain the company data warehouse.',
      sourceUrl: 'https://example.com/jobs?q=artificial+intelligence',
    },
    {
      title: 'Software Engineer',
      description: 'Our company uses AI. Build billing APIs and internal admin tools.',
    },
    {
      title: 'Software Engineer',
      description: 'Collaborate with the computer vision team. Model billing data in PostgreSQL.',
    },
  ];

  assert.deepEqual(
    filterAiMlJobs(jobs).map((job) => job.title),
    ['Research Engineer', 'Computer Vision Engineer'],
  );
});

test('does not classify an AI/ML area from the title alone', () => {
  const job = { title: 'Computer Vision Engineer' };
  assert.equal(aiMlAreaForJob(job), 'other_ai_ml');
  assert.equal(roleFamilyForJob(job), 'ml_engineer');
});

test('does not guess when description evidence is tied across areas', () => {
  assert.equal(
    aiMlAreaForJob({
      title: 'Machine Learning Engineer',
      description: 'Teams include computer vision, NLP, recommendations, and forecasting.',
    }),
    'other_ai_ml',
  );
});

test('separates scientist roles from ML engineers', () => {
  const description = 'Build generative AI applications using large language models.';
  assert.equal(
    roleFamilyForJob({ title: 'Machine Learning Engineer', description }),
    'ml_engineer',
  );
  assert.equal(
    roleFamilyForJob({ title: 'Data Scientist', description }),
    'data_scientist',
  );
  assert.equal(
    roleFamilyForJob({ title: 'Applied Scientist', description }),
    'applied_scientist',
  );
  assert.equal(
    roleFamilyForJob({ title: 'Research Scientist', description }),
    'research_scientist',
  );
});

test('keeps non-AI data and software categories unchanged', () => {
  assert.equal(roleFamilyForJob({ title: 'Data Engineer' }), 'data');
  assert.equal(roleFamilyForJob({ title: 'Backend Software Engineer' }), 'software');
  assert.equal(aiMlAreaForJob({ title: 'Data Engineer' }), '');
});

test('persists role category and description-derived area separately', () => {
  const tagged = tagJobRoleFamily({
    title: 'Data Scientist',
    description: 'Build computer vision and image segmentation models.',
  });
  assert.equal(tagged.roleFamily, 'data_scientist');
  assert.equal(tagged.category, 'data_scientist');
  assert.equal(tagged.aiMlArea, 'computer_vision');
});

test('default discovery searches include each AI/ML role type', () => {
  assert.deepEqual(AI_ML_JOB_SEARCHES, [
    'machine learning engineer',
    'ai engineer',
    'artificial intelligence engineer',
    'data scientist',
    'applied scientist',
    'research scientist machine learning',
    'deep learning engineer',
  ]);
});
