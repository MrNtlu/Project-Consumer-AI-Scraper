/**
 * Pinecone Recommendation System
 *
 * This module provides functionality to get recommendations from Pinecone
 * and fetch detailed information from MongoDB. It supports:
 * - Finding similar items by ID (recommendById)
 * - Searching for content with text queries (searchByText)
 * - Getting recommendations based on user preferences (recommendForUser)
 * - Retrieving full document details from MongoDB (getContentDetails)
 * - Getting detailed recommendations with MongoDB data (getDetailedRecommendations)
 */

import { config } from "dotenv";
config();
import { Pinecone } from "@pinecone-database/pinecone";
import { MongoClient, ObjectId } from 'mongodb';
import OpenAI from 'openai';

// Initialize clients
const pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
const mongoClient = new MongoClient(process.env.MONGODB_URI);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
console.log('✅ Clients initialized');

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

    // Try string ID first, then ObjectId
    let doc = await collection.findOne({ _id: id });
    if (!doc) {
      try {
        doc = await collection.findOne({ _id: new ObjectId(id) });
      } catch (e) {
        // Ignore ObjectId conversion errors
      }
    }

    return doc;
  } catch (error) {
    console.error(`MongoDB fetch error: ${error.message}`);
    return null;
  }
}

// Generate embedding vector using OpenAI
async function generateEmbedding(text) {
  try {
    if (!text) throw new Error("Text is required for embedding");

    const response = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: text,
      dimensions: 1536
    });

    return response.data[0].embedding;
  } catch (error) {
    console.error(`Error generating embedding: ${error.message}`);
    return null;
  }
}

// Get MongoDB docs for multiple Pinecone results
async function getMongoDBDocs(pineconeResults) {
  const results = [];

  for (const item of pineconeResults) {
    const type = item.metadata?.type;
    if (!type) continue;

    const doc = await fetchFromMongoDB(item.id, type);
    if (doc) {
      results.push({
        id: item.id,
        score: item.score,
        type: type,
        data: doc
      });
    }
  }

  return results;
}

// Find similar items and return MongoDB data
async function recommendById(itemId, topK = 10) {
  try {
    const index = pinecone.Index(process.env.PINECONE_INDEX);
    const res = await index.query({
      id: itemId,
      topK,
      includeMetadata: true
    });

    // Return MongoDB data for results
    return await getMongoDBDocs(res.matches || []);
  } catch (error) {
    console.error(`recommendById error: ${error.message}`);
    return [];
  }
}

// Search by text and return MongoDB data
async function searchByText(queryText, topK = 10) {
  try {
    const index = pinecone.Index(process.env.PINECONE_INDEX);

    // Generate proper vector embedding with OpenAI
    const embedding = await generateEmbedding(queryText);
    if (!embedding) {
      throw new Error("Failed to generate embedding for query text");
    }

    const res = await index.query({
      vector: embedding,
      topK,
      includeMetadata: true
    });

    // Return MongoDB data for results
    return await getMongoDBDocs(res.matches || []);
  } catch (error) {
    console.error(`searchByText error: ${error.message}`);
    return [];
  }
}

// Get user content lists using aggregation
async function getUserContentLists(userId) {
  try {
    if (!mongoClient.topology || !mongoClient.topology.isConnected()) {
      await mongoClient.connect();
    }

    const db = mongoClient.db();

    const pipeline = [
      { $match: { user_id: userId } },
      {
        $lookup: {
          from: "anime-lists",
          localField: "user_id",
          foreignField: "user_id",
          as: "anime_lists"
        }
      },
      {
        $lookup: {
          from: "game-lists",
          localField: "user_id",
          foreignField: "user_id",
          as: "game_lists"
        }
      },
      {
        $lookup: {
          from: "movie-watch-lists",
          localField: "user_id",
          foreignField: "user_id",
          as: "movie_watch_lists"
        }
      },
      {
        $lookup: {
          from: "tvseries-watch-lists",
          localField: "user_id",
          foreignField: "user_id",
          as: "tvseries_watch_lists"
        }
      }
    ];

    const result = await db.collection('user-lists').aggregate(pipeline).toArray();
    return result[0] || null;
  } catch (error) {
    console.error(`Error fetching user content lists: ${error.message}`);
    return null;
  }
}

// Extract content IDs from user lists
function extractContentIds(userLists) {
  if (!userLists) return { movies: [], tvSeries: [], animes: [], games: [] };

  const contentIds = {
    movies: [],
    tvSeries: [],
    animes: [],
    games: []
  };

  if (userLists.movie_watch_lists) {
    for (const item of userLists.movie_watch_lists) {
      if (item.movie_id) contentIds.movies.push(item.movie_id);
    }
  }

  if (userLists.tvseries_watch_lists) {
    for (const item of userLists.tvseries_watch_lists) {
      if (item.tvseries_id || item.tv_id) {
        contentIds.tvSeries.push(item.tvseries_id || item.tv_id);
      }
    }
  }

  if (userLists.anime_lists) {
    for (const item of userLists.anime_lists) {
      if (item.anime_id) contentIds.animes.push(item.anime_id);
    }
  }

  if (userLists.game_lists) {
    for (const item of userLists.game_lists) {
      if (item.game_id) contentIds.games.push(item.game_id);
    }
  }

  return contentIds;
}

// Recommend based on user watch/play history
async function recommendForUser(userIds = [], topK = 10) {
  try {
    if (!userIds.length) return [];

    const userId = userIds[0];
    console.log(`Getting recommendations for user: ${userId}`);

    // Get user content lists
    const userLists = await getUserContentLists(userId);
    if (!userLists) {
      console.warn(`No user found with ID: ${userId}`);
      return [];
    }

    // Extract content IDs
    const contentIds = extractContentIds(userLists);
    console.log('Content IDs found:', {
      movies: contentIds.movies.length,
      tvSeries: contentIds.tvSeries.length,
      animes: contentIds.animes.length,
      games: contentIds.games.length
    });

    // Get recommendations per content type
    const perTypeCount = Math.ceil(topK / 4); // Split recommendations equally
    const recommendations = [];

    // Get recommendations based on movies
    if (contentIds.movies.length > 0) {
      const movieRecs = await getRecommendationsByType(contentIds.movies, 'movie', perTypeCount);
      recommendations.push(...movieRecs);
    }

    // Get recommendations based on TV series
    if (contentIds.tvSeries.length > 0) {
      const tvRecs = await getRecommendationsByType(contentIds.tvSeries, 'tvseries', perTypeCount);
      recommendations.push(...tvRecs);
    }

    // Get recommendations based on animes
    if (contentIds.animes.length > 0) {
      const animeRecs = await getRecommendationsByType(contentIds.animes, 'anime', perTypeCount);
      recommendations.push(...animeRecs);
    }

    // Get recommendations based on games
    if (contentIds.games.length > 0) {
      const gameRecs = await getRecommendationsByType(contentIds.games, 'game', perTypeCount);
      recommendations.push(...gameRecs);
    }

    // Remove duplicates and limit to topK results
    const uniqueRecs = [];
    const seenIds = new Set();

    for (const rec of recommendations) {
      if (!seenIds.has(rec.id)) {
        seenIds.add(rec.id);
        uniqueRecs.push(rec);
        if (uniqueRecs.length >= topK) break;
      }
    }

    return uniqueRecs;
  } catch (error) {
    console.error(`recommendForUser error: ${error.message}`);
    return [];
  }
}

async function getRecommendationsByType(contentIds, contentType, perTypeCount) {
  const recommendations = [];
  const idLimit = Math.min(3, contentIds.length);

  for (let i = 0; i < idLimit; i++) {
    const typeRecs = await recommendById(contentIds[i], Math.ceil(perTypeCount / idLimit));
    recommendations.push(...typeRecs.filter(rec => rec.type === contentType));
  }

  return recommendations;
}

/**
 * Get detailed information from MongoDB for a recommended item
 * @param {string} id - The ID of the item
 * @param {string} type - The type of content (movie, tvseries, anime, game)
 * @returns {Object|null} - The detailed document from MongoDB or null if not found
 */
async function getContentDetails(id, type) {
    try {
        // Connect to MongoDB if not already connected
        if (!mongoClient.topology || !mongoClient.topology.isConnected()) {
            await mongoClient.connect();
            console.log('MongoDB connected');
        }

        // Map type to collection name
        let collectionName;
        switch (type) {
            case 'movie':
                collectionName = 'movies';
                break;
            case 'tvseries':
                collectionName = 'tv-series';
                break;
            case 'anime':
                collectionName = 'animes';
                break;
            case 'game':
                collectionName = 'games';
                break;
            default:
                throw new Error(`Unknown content type: ${type}`);
        }

        // Query MongoDB
        const db = mongoClient.db();
        const collection = db.collection(collectionName);

        // Try to find by string ID first
        let doc = await collection.findOne({ _id: id });

        // If not found, convert string ID to MongoDB ObjectId if possible
        if (!doc) {
            try {
                const objectId = new ObjectId(id);
                doc = await collection.findOne({ _id: objectId });
            } catch (e) {
                // If conversion fails, ignore error
                console.warn(`Could not convert ${id} to ObjectId: ${e.message}`);
            }
        }

        if (!doc) {
            console.warn(`Document not found in ${collectionName} with id: ${id}`);
            return null;
        }

        console.log(`Found document in ${collectionName}:`, {
            _id: doc._id,
            title: doc.title || doc.title_en || doc.title_original,
            type: type
        });

        return doc;
    } catch (error) {
        console.error(`Error in getContentDetails: ${error.message}`);
        return null;
    }
}

// Export functions
export { recommendById, searchByText, recommendForUser };

// Demo
(async () => {
  try {
    console.log("\n=== RECOMMENDATION BY ID ===");
    const recs = await recommendById("64e4d1b1f21df069d4035819", 10);
    console.log(`Found ${recs.length} recommendations`);
    console.log(recs.map(r => ({
      id: r.id,
      type: r.type,
      title: r.data.title || r.data.title_en || r.data.title_original,
      score: r.score.toFixed(3)
    })));

    console.log("\n=== SEARCH BY TEXT ===");
    const searchResults = await searchByText("Along with the Gods", 10);
    console.log(`Found ${searchResults.length} search results`);
    console.log(searchResults.map(r => ({
      id: r.id,
      type: r.type,
      title: r.data.title || r.data.title_en || r.data.title_original,
      score: r.score.toFixed(3)
    })));

    console.log("\n=== USER RECOMMENDATIONS ===");
    const userRecs = await recommendForUser(["6554f275a13b3e85bb72d362"], 10);
    console.log(`Found ${userRecs.length} user recommendations`);
    console.log(userRecs.map(r => ({
      id: r.id,
      type: r.type,
      title: r.data.title || r.data.title_en || r.data.title_original,
      score: r.score.toFixed(3)
    })));
  } catch (error) {
    console.error("Error:", error);
  } finally {
    if (mongoClient.topology?.isConnected()) await mongoClient.close();
    process.exit(0);
  }
})();