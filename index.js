import 'dotenv/config';  // Load .env into process.env

import { MongoClient } from 'mongodb';
import OpenAI from 'openai';
import { Pinecone } from '@pinecone-database/pinecone';

// ---------------------------
// 1. Initialize all clients
// ---------------------------
async function initClients() {
  console.log('🔌 Initializing clients...');

  // MongoDB
  const mongo = new MongoClient(process.env.MONGODB_URI);
  await mongo.connect();
  console.log('✅ Connected to MongoDB');

  // OpenAI
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  console.log('✅ OpenAI client ready');

  // Pinecone
  const pinecone = new Pinecone({
    apiKey: process.env.PINECONE_API_KEY,
  });
  console.log('✅ Pinecone client ready');

  return { mongo, openai, pinecone };
}

// ----------------------------------------
// 2. Ensure Pinecone index exists or create
// ----------------------------------------
async function ensureIndex(pinecone) {
  const indexName = process.env.PINECONE_INDEX;
  console.log(`🗄 Checking Pinecone index: ${indexName}`);

  const indexes = await pinecone.listIndexes();
  console.log('Indexes:', JSON.stringify(indexes, null, 2));

  const indexExists = indexes.indexes?.some(index => index.name === indexName);
  if (!indexExists) {
    console.log(`🚀 Creating Pinecone index: ${indexName}`);
    await pinecone.createIndex({
      name: indexName,
      dimension: 1536,
      metric: 'cosine',
      spec: {
        serverless: {
          cloud: 'aws',
          region: process.env.PINECONE_ENVIRONMENT
        }
      }
    });
    console.log('✅ Pinecone index created');
  } else {
    console.log('ℹ️ Pinecone index already exists');
  }

  return pinecone.index(indexName);
}

// -----------------------------------------
// 3. Build text for embedding per type
// -----------------------------------------
function buildText(doc, type) {
  let text = '';
  switch (type) {
    case 'animes': {
      const chars = (doc.characters || []).slice(0, 10).map(c => c.name);
      const demos = (doc.demographics || []).map(d => d.name);
      const genres = (doc.genres || []).map(g => g.name);
      const producers = (doc.producers || []).map(p => p.name);
      const relations = (doc.relations || []).flatMap(r => [r.relation, ...r.source.map(s => s.name)]);
      const studios = (doc.studios || []).map(s => s.name);
      const themes = (doc.themes || []).map(t => t.name);
      text = `${doc.title_en || doc.title_original} is an anime${doc.title_jp ? ` (${doc.title_jp})` : ''}. ` +
             `Description: ${doc.description || 'No description available.'} ` +
             `Characters: ${chars.join(', ')}. ` +
             `Demographics: ${demos.join(', ')}. Genres: ${genres.join(', ')}. ` +
             `Producers: ${producers.join(', ')}. ` +
             `Relations: ${relations.join(', ')}. ` +
             `Studios: ${studios.join(', ')}. Themes: ${themes.join(', ')}.`;
      break;
    }

    case 'movies': {
      const actors = (doc.actors || []).slice(0, 10).map(a => a.name);
      const genres = (doc.genres || []);
      const companies = (doc.production_companies || []).map(pc => pc.name);
      text = `${doc.title_en || doc.title_original} is a movie. ` +
             `Plot: ${doc.description || 'No description available.'} ` +
             `Starring: ${actors.join(', ')}. Genres: ${genres.join(', ')}. ` +
             `Production: ${companies.join(', ')}.`;
      break;
    }

    case 'tv-series': {
      const actors = (doc.actors || []).slice(0, 10).map(a => a.name);
      const genres = (doc.genres || []);
      const nets = (doc.networks || []).map(n => n.name);
      const companies = (doc.production_companies || []).map(pc => pc.name);
      text = `${doc.title_en || doc.title_original} is a TV series. ` +
             `Overview: ${doc.description || 'No description available.'} ` +
             `Cast: ${actors.join(', ')}. Genres: ${genres.join(', ')}. ` +
             `Networks: ${nets.join(', ')}. Production: ${companies.join(', ')}.`;
      break;
    }

    case 'games': {
      const developers = (doc.developers || []);
      const genres = (doc.genres || []);
      const platforms = (doc.platforms || []);
      const publishers = (doc.publishers || []);
      const tags = (doc.tags || []);
      text = `${doc.title || doc.title_original} is a game. ` +
             `About: ${(doc.description || '').replace(/<[^>]+>/g, '')} ` +
             `Developed by: ${developers.join(', ')}. Genres: ${genres.join(', ')}. ` +
             `Metacritic Score: ${doc.metacritic_score || 'N/A'}. Platforms: ${platforms.join(', ')}. ` +
             `Published by: ${publishers.join(', ')}. Tags: ${tags.join(', ')}.`;
      break;
    }

    default:
      text = `${doc.title_en || doc.title || ''}: ${doc.description || ''}`;
  }
  return text;
}

// -------------------------------------------------------------------
// 4. Ingest one MongoDB collection into Pinecone (with batching & logs)
// -------------------------------------------------------------------
async function ingestCollection({ mongo, openai, pineconeIndex }, collName, contentType) {
  console.log(`📂 Starting ingestion for collection: ${collName}`);
  const cursor = mongo.db().collection(collName).find({});
  const BATCH_SIZE = 50;
  let batch = [];
  let processed = 0;

  while (await cursor.hasNext()) {
    const doc = await cursor.next();
    processed++;

    // Log every 100 items
    if (processed % 100 === 0) {
      console.log(`🔄 [${contentType}] Processed ${processed} documents`);
    }

    const text = buildText(doc, collName);
    const embeddingRes = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: text,
    });
    const vector = embeddingRes.data[0].embedding;

    batch.push({
      id: doc._id.toString(),
      values: vector,
      metadata: { type: contentType }
    });

    if (batch.length >= BATCH_SIZE) {
      console.log(`🚀 [${contentType}] Upserting batch of ${batch.length}`);
      await pineconeIndex.upsert(batch);
      console.log(`✅ [${contentType}] Upserted batch`);
      batch = [];
    }
  }

  if (batch.length) {
    console.log(`🚀 [${contentType}] Upserting final batch of ${batch.length}`);
    await pineconeIndex.upsert(batch);
    console.log(`✅ [${contentType}] Final batch upserted`);
  }

  console.log(`🎉 Completed ingestion for ${collName}: ${processed} documents processed`);
}

// ---------------------------
// 5. Main orchestrator
// ---------------------------
async function main() {
  const { mongo, openai, pinecone } = await initClients();
  const pineconeIndex = await ensureIndex(pinecone);

  const collections = [
    ['movies', 'movie'],
    ['tv-series', 'tvseries'],
    ['animes', 'anime'],
    ['games', 'game'],
  ];

  for (const [coll, type] of collections) {
    try {
      await ingestCollection({ mongo, openai, pineconeIndex }, coll, type);
    } catch (err) {
      console.error(`❌ Error ingesting ${coll}:`, err);
    }
  }

  await mongo.close();
  console.log('🏁 All collections ingested successfully');
}

main().catch(err => {
  console.error('Fatal error in ingestion script:', err);
  process.exit(1);
});