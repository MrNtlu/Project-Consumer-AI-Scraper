/**
 * Pinecone Recommendation System
 *
 * This module provides demo functionality for Pinecone recommendation system.
 * The main recommendation functionality has been moved to the recommendations folder.
 */

import { config } from "dotenv";
config();
import { MongoClient } from 'mongodb';
import { recommendById, recommendForUser } from './recommendations/index.js';

// Initialize MongoDB client for demo
const mongoClient = new MongoClient(process.env.MONGODB_URI);

// Helper to format recommendations
function formatRecommendations(recs) {
  return recs.map(r => {
    try {
      return {
        id: r.id,
        type: r.type,
        title: r.data?.title || r.data?.title_en || r.data?.title_original || 'Unknown Title',
        score: typeof r.score === 'number' ? r.score.toFixed(3) : 'N/A'
      };
    } catch (err) {
      return { id: r.id || 'unknown', type: r.type || 'unknown', error: 'Malformed recommendation' };
    }
  });
}

// Demo
(async () => {
  try {
    // Uncomment to test recommendById
    // console.log("\n=== RECOMMENDATION BY ID ===");
    // const recs = await recommendById("64e4d1b1f21df069d4035819", 10);
    // console.log(`Found ${recs.length} recommendations`);
    // console.log(recs.map(r => ({
    //   id: r.id,
    //   type: r.type,
    //   title: r.data.title || r.data.title_en || r.data.title_original,
    //   score: r.score.toFixed(3)
    // })));

    console.log("\n=== USER RECOMMENDATIONS ===");
    const recommendations = await recommendForUser(["6554f275a13b3e85bb72d362"], 10);

    if (!recommendations || (!recommendations.all && !Array.isArray(recommendations)) ||
        (recommendations.all && recommendations.all.length === 0)) {
      console.log("No recommendations found.");
      return;
    }

    // Handle both old and new return formats
    if (Array.isArray(recommendations)) {
      console.log(`\nFound ${recommendations.length} total recommendations`);
      console.table(formatRecommendations(recommendations));
    } else {
      // Display each content type's recommendations
      const contentTypes = [
        { type: 'Movie', data: recommendations.movies || [] },
        { type: 'TV Series', data: recommendations.tvSeries || [] },
        { type: 'Anime', data: recommendations.animes || [] },
        { type: 'Game', data: recommendations.games || [] }
      ];

      let totalRecs = 0;

      for (const { type, data } of contentTypes) {
        totalRecs += data.length;

        if (data.length > 0) {
          console.log(`\n== ${type} Recommendations (${data.length}) ==`);
          console.table(formatRecommendations(data));
        } else {
          console.log(`\n== ${type} Recommendations: None found ==`);
        }
      }

      console.log(`\nTotal recommendations across all content types: ${totalRecs}`);
    }
  } catch (error) {
    console.error("Error:", error);
  } finally {
    if (mongoClient.topology?.isConnected()) {
      await mongoClient.close();
      console.log("MongoDB connection closed");
    }
    process.exit(0);
  }
})();