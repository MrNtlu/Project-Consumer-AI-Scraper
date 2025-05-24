import { Pinecone } from "@pinecone-database/pinecone";
import { MongoClient, ObjectId } from 'mongodb';
import { config } from "dotenv";
config();

// Initialize clients
const pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
const mongoClient = new MongoClient(process.env.MONGODB_URI);

// Map content type to MongoDB collection name
function getCollectionName(type) {
  switch (type) {
    case 'movie': return 'movies';
    case 'tvseries': return 'tv-series';
    case 'anime': return 'animes';
    case 'game': return 'games';
    default: throw new Error(`Unknown content type: ${type}`);
  }
}

// Fetch MongoDB document by ID and type
async function fetchFromMongoDB(id, type) {
  try {
    if (!mongoClient.topology || !mongoClient.topology.isConnected()) {
      await mongoClient.connect();
    }

    const db = mongoClient.db();
    const collection = db.collection(getCollectionName(type));

    // Try string ID first
    let doc = await collection.findOne({ _id: id });

    // If not found, try with ObjectId
    if (!doc) {
      try {
        doc = await collection.findOne({ _id: new ObjectId(id) });
      } catch (e) {} // Ignore ObjectId conversion errors
    }

    return doc;
  } catch (error) {
    console.error(`MongoDB fetch error: ${error.message}`);
    return null;
  }
}

// Get MongoDB docs for multiple Pinecone results
async function getMongoDBDocs(pineconeResults) {
  const fetchPromises = pineconeResults
    .filter(item => item.metadata?.type) // Filter out items without type
    .map(async (item) => {
      const doc = await fetchFromMongoDB(item.id, item.metadata.type);
      if (doc) {
        return {
          id: item.id,
          score: item.score,
          type: item.metadata.type,
          data: doc
        };
      }
      return null;
    });

  // Wait for all fetches to complete and filter out nulls
  const results = (await Promise.all(fetchPromises)).filter(Boolean);
  return results;
}

// Find similar items and return MongoDB data
async function recommendById(itemId, topK = 10) {
  try {
    const index = pinecone.Index(process.env.PINECONE_INDEX);
    const res = await index.query({
      id: itemId,
      topK: topK + 1, // Request one extra to account for removing the original item
      includeMetadata: true
    });

    // Filter out the original item and limit to topK
    const filteredMatches = (res.matches || [])
      .filter(match => match.id !== itemId)
      .slice(0, topK);

    // Return MongoDB data for results
    return await getMongoDBDocs(filteredMatches);
  } catch (error) {
    console.error(`recommendById error: ${error.message}`);
    return [];
  }
}

export { recommendById, getMongoDBDocs, getCollectionName, fetchFromMongoDB };