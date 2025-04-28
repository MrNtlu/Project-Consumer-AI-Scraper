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

// Helper function to delay execution
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Helper function to handle rate limits with exponential backoff
async function withRetry(fn, maxRetries = 5, initialWaitTime = 4400) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      // Handle OpenAI rate limits
      if (error?.error?.type === 'requests' && error.status === 429) {
        const waitTime = initialWaitTime * Math.pow(1.5, attempt - 1);
        console.log(`⏳ Rate limit hit, waiting ${waitTime/1000}s before retry ${attempt}/${maxRetries}`);
        await sleep(waitTime);
        continue;
      }

      // Handle timeout errors
      if (error.message && (error.message.includes('timeout') || error.message.includes('timed out'))) {
        const waitTime = initialWaitTime * Math.pow(1.5, attempt - 1);
        console.log(`⏳ Timeout error, waiting ${waitTime/1000}s before retry ${attempt}/${maxRetries}`);
        await sleep(waitTime);
        continue;
      }

      if (attempt < maxRetries) {
        console.log(`⚠️ Error in attempt ${attempt}, retrying...`, error.message || error);
        await sleep(initialWaitTime * Math.pow(1.5, attempt - 1));
        continue;
      }
      throw error;
    }
  }
  throw new Error(`Failed after ${maxRetries} retries`);
}

// -------------------------------------------------------------------
// 4. Ingest one MongoDB collection into Pinecone (with batching & logs)
// -------------------------------------------------------------------
async function ingestCollection({ mongo, openai, pineconeIndex }, collName, contentType) {
  console.log(`📂 Starting ingestion for collection: ${collName}`);
  const collection = mongo.db().collection(collName);
  const BATCH_SIZE = 50;
  let processed = 0;
  let failedAttempts = 0;

  try {
    // Get total count for progress tracking
    const totalDocuments = await collection.countDocuments({});
    console.log(`📊 Total documents to process: ${totalDocuments}`);

    // Use MongoDB's built-in batch processing
    let batchNum = 0;
    let hasMoreData = true;

    while (hasMoreData) {
      try {
        batchNum++;
        console.log(`🔄 Processing batch #${batchNum} (skipping ${processed} documents)`);

        // Get next batch with error handling
        let batch = [];
        try {
          batch = await withRetry(async () => {
            return await collection.find({})
              .skip(processed)
              .limit(BATCH_SIZE)
              .toArray();
          }, 3);
        } catch (err) {
          console.error(`⚠️ Error fetching batch #${batchNum}, will retry:`, err.message || err);
          await sleep(5000); // Wait before retrying
          continue;
        }

        // Check if we've processed all documents
        if (batch.length === 0) {
          console.log(`✅ All documents processed for ${collName}`);
          hasMoreData = false;
          break;
        }

        const documents = batch.map(doc => ({
          id: doc._id.toString(),
          text: buildText(doc, collName)
        }));

        // Process the batch with more robust error handling
        try {
          await processBatch(documents, openai, pineconeIndex, contentType);
          processed += batch.length;
          failedAttempts = 0; // Reset failed attempts counter after success

          // Log progress
          console.log(`🔄 [${contentType}] Progress: ${processed}/${totalDocuments} (${Math.round(processed/totalDocuments*100)}%)`);

          // Small delay between successful batches
          await sleep(1000);
        } catch (err) {
          failedAttempts++;
          console.error(`❌ Failed to process batch #${batchNum} (attempt ${failedAttempts}):`, err.message || err);

          if (failedAttempts >= 5) {
            console.error(`⛔ Too many failed attempts on batch #${batchNum}, skipping this batch`);
            processed += batch.length; // Skip this batch after too many failures
            failedAttempts = 0;
          }

          // Wait longer between failed attempts
          await sleep(5000 * failedAttempts);
        }
      } catch (batchErr) {
        console.error(`⚠️ Error in batch processing loop for ${collName}:`, batchErr.message || batchErr);
        await sleep(5000);
        // Continue to next iteration, don't break the loop
      }
    }

    console.log(`🎉 Completed ingestion for ${collName}: ${processed} documents processed`);
  } catch (err) {
    console.error(`❌ Error ingesting ${collName}:`, err);
    console.log(`🔄 Will continue with remaining collections`);
  }
}

async function processBatch(documents, openai, pineconeIndex, contentType) {
  // Get embeddings for all texts in the batch at once
  const texts = documents.map(doc => doc.text);

  console.log(`🔄 Getting embeddings for batch of ${texts.length} documents`);

  // More robust retry for OpenAI embedding
  const embeddingRes = await withRetry(async () => {
    return await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: texts,
    });
  });

  // Prepare vectors for Pinecone
  const vectors = documents.map((doc, i) => ({
    id: doc.id,
    values: embeddingRes.data[i].embedding,
    metadata: { type: contentType }
  }));

  // Upsert vectors to Pinecone with better error handling
  console.log(`🚀 Upserting batch of ${vectors.length} vectors`);
  await withRetry(async () => {
    await pineconeIndex.upsert(vectors);
  });
  console.log(`✅ Batch upserted successfully`);
}

// ---------------------------
// 5. Main orchestrator
// ---------------------------
async function main() {
  let mongo;

  try {
    const clients = await initClients();
    mongo = clients.mongo;
    const { openai, pinecone } = clients;
    const pineconeIndex = await ensureIndex(pinecone);

    const collections = [
      ['movies', 'movie'],
      ['tv-series', 'tvseries'],
      ['animes', 'anime'],
      ['games', 'game'],
    ];

    // Process collections sequentially to avoid overwhelming connections
    for (const [coll, type] of collections) {
      try {
        await ingestCollection({ mongo, openai, pineconeIndex }, coll, type);
      } catch (err) {
        console.error(`❌ Error during processing of ${coll}:`, err);
        console.log(`🔄 Continuing with next collection...`);
        // Continue to next collection even if this one failed
      }
    }

    console.log('🏁 All collections processed');
  } catch (err) {
    console.error('❌ Fatal error in ingestion script:', err);
  } finally {
    // Ensure MongoDB connection is closed properly
    if (mongo) {
      try {
        await mongo.close();
        console.log('📡 MongoDB connection closed');
      } catch (closeErr) {
        console.error('❌ Error closing MongoDB connection:', closeErr);
      }
    }
  }
}

main().catch(err => {
  console.error('Fatal error in ingestion script:', err);
  process.exit(1);
});