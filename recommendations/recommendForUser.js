import { MongoClient } from 'mongodb';
import { config } from "dotenv";
config();
import OpenAI from 'openai';
import { recommendById } from './recommendById.js';
import { ObjectId } from 'mongodb';

// Initialize clients
const mongoClient = new MongoClient(process.env.MONGODB_URI);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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

// Extract content IDs and details from user lists
async function extractUserContent(userLists) {
  if (!userLists) return {
    movies: [], tvSeries: [], animes: [], games: [],
    movieDetails: [], tvSeriesDetails: [], animeDetails: [], gameDetails: []
  };

  // Extract IDs
  const contentIds = {
    movies: [],
    tvSeries: [],
    animes: [],
    games: []
  };

  // Extract movie IDs
  if (userLists.movie_watch_lists) {
    contentIds.movies = userLists.movie_watch_lists
      .filter(item => item.movie_id)
      .map(item => item.movie_id);
  }

  // Extract TV series IDs
  if (userLists.tvseries_watch_lists) {
    contentIds.tvSeries = userLists.tvseries_watch_lists
      .filter(item => item.tvseries_id || item.tv_id)
      .map(item => item.tvseries_id || item.tv_id);
  }

  // Extract anime IDs
  if (userLists.anime_lists) {
    contentIds.animes = userLists.anime_lists
      .filter(item => item.anime_id)
      .map(item => item.anime_id);
  }

  // Extract game IDs
  if (userLists.game_lists) {
    contentIds.games = userLists.game_lists
      .filter(item => item.game_id)
      .map(item => item.game_id);
  }

  // Fetch details for each content type
  const [movieDetails, tvSeriesDetails, animeDetails, gameDetails] = await Promise.all([
    fetchContentDetails(contentIds.movies, 'movie'),
    fetchContentDetails(contentIds.tvSeries, 'tvseries'),
    fetchContentDetails(contentIds.animes, 'anime'),
    fetchContentDetails(contentIds.games, 'game')
  ]);

  return {
    ...contentIds,
    movieDetails,
    tvSeriesDetails,
    animeDetails,
    gameDetails
  };
}

// Fetch content details from MongoDB
async function fetchContentDetails(ids, contentType) {
  if (!ids.length) return [];

  try {
    if (!mongoClient.topology || !mongoClient.topology.isConnected()) {
      await mongoClient.connect();
    }

    const db = mongoClient.db();
    const collectionName = getCollectionName(contentType);
    const collection = db.collection(collectionName);

    // Convert string IDs to ObjectIDs where possible
    const objectIdQueries = [];
    const stringIdQueries = [];

    for (const id of ids) {
      if (!id) continue;

      try {
        objectIdQueries.push({ _id: new ObjectId(id) });
      } catch (e) {
        stringIdQueries.push({ _id: id });
      }
    }

    // If we have no valid queries, return empty array
    if (objectIdQueries.length === 0 && stringIdQueries.length === 0) {
      console.log(`No valid ID queries for ${contentType}`);
      return [];
    }

    const query = {
      $or: [...objectIdQueries, ...stringIdQueries]
    };

    const results = await collection.find(query).toArray();
    console.log(`Found ${results.length} ${contentType} items out of ${ids.length} IDs`);
    return results;
  } catch (error) {
    console.error(`Error fetching ${contentType} details: ${error.message}`);
    return [];
  }
}

// Get collection name from content type
function getCollectionName(type) {
  switch (type) {
    case 'movie': return 'movies';
    case 'tvseries': return 'tv-series';
    case 'anime': return 'animes';
    case 'game': return 'games';
    default: throw new Error(`Unknown content type: ${type}`);
  }
}

// Get recommendations for a specific content type with prioritization
async function getRecommendationsByType(contentData, contentType, perTypeCount, userContentSet) {
  if (!contentData.length) return [];

  try {
    // Step 1: First prioritize series/sequels for each item
    const sequelRecs = await findSequelsAndSeries(contentData, contentType, userContentSet);

    // If we have enough sequel recommendations, return them
    if (sequelRecs.length >= perTypeCount) {
      return sequelRecs.slice(0, perTypeCount);
    }

    // Step 2: For remaining slots, get similarity-based recommendations
    const remainingCount = perTypeCount - sequelRecs.length;

    // Use a sample of user's content for recommendations (up to 3 items)
    const sampleIds = contentData.slice(0, 3).map(item => item._id?.toString() || item.id?.toString());

    // Make sure we have valid IDs
    const validSampleIds = sampleIds.filter(Boolean);

    if (validSampleIds.length === 0) {
      console.log(`No valid IDs found for ${contentType} recommendations`);
      return sequelRecs;
    }

    // Get recommendations based on vector similarity
    const similarityPromises = validSampleIds.map(async id => {
      try {
        const recs = await recommendById(id, Math.ceil(remainingCount / validSampleIds.length) * 2);
        return recs || [];
      } catch (error) {
        console.error(`Error getting recommendations for ID ${id}: ${error.message}`);
        return [];
      }
    });

    // Wait for all recommendation requests to complete
    const allRecommendations = await Promise.all(similarityPromises);

    // Combine and filter recommendations
    const similarityRecs = allRecommendations
      .flat()
      .filter(rec =>
        // Make sure the recommendation is valid
        rec && rec.type && rec.id &&
        // Must be the right content type
        rec.type === contentType &&
        // Must not be in user's content list
        !userContentSet.has(rec.id) &&
        // Must not already be in sequel recommendations
        !sequelRecs.some(seqRec => seqRec.id === rec.id)
      )
      .slice(0, remainingCount);

    // Combine sequel and similarity recommendations
    return [...sequelRecs, ...similarityRecs];
  } catch (error) {
    console.error(`Error in getRecommendationsByType for ${contentType}: ${error.message}`);
    return sequelRecs || [];
  }
}

// Find sequels and series content not yet consumed by user
async function findSequelsAndSeries(contentData, contentType, userContentSet) {
  if (!contentData.length) return [];

  console.log(`Looking for sequels and series for ${contentData.length} ${contentType} items`);
  const recommendations = [];

  try {
    // Get collection for this content type
    if (!mongoClient.topology || !mongoClient.topology.isConnected()) {
      await mongoClient.connect();
    }

    const db = mongoClient.db();
    const collectionName = getCollectionName(contentType);
    const collection = db.collection(collectionName);

    // Process each content item
    for (const content of contentData) {
      try {
        let titleParts = [];
        const title = content.title || content.title_en || content.title_original || '';

        if (!title) continue;

        // Extract series name and potential number/season
        const seriesInfo = extractSeriesInfo(title);

        if (seriesInfo.seriesName) {
          console.log(`Looking for series content for "${seriesInfo.seriesName}"`);

          // Search for other content in the same series
          const query = {
            $and: [
              // Similar title (using regex to match series name)
              {
                $or: [
                  { title: { $regex: escapeRegex(seriesInfo.seriesName), $options: 'i' } },
                  { title_en: { $regex: escapeRegex(seriesInfo.seriesName), $options: 'i' } },
                  { title_original: { $regex: escapeRegex(seriesInfo.seriesName), $options: 'i' } }
                ]
              },
              // Not the same content
              { _id: { $ne: content._id } }
            ]
          };

          // Find potential series content
          const potentialSeriesContent = await collection.find(query).limit(5).toArray();
          console.log(`Found ${potentialSeriesContent.length} potential sequels for "${title}"`);

          // Filter out content the user already has
          const filteredSeriesContent = potentialSeriesContent.filter(item =>
            item._id && !userContentSet.has(item._id.toString())
          );

          if (filteredSeriesContent.length > 0) {
            console.log(`Found ${filteredSeriesContent.length} unwatched sequels for "${title}"`);

            // Score based on metadata similarity
            const scoredContent = filteredSeriesContent.map(item => {
              const score = calculateMetadataSimilarity(content, item, contentType);
              return { item, score };
            });

            // Sort by similarity score (highest first)
            scoredContent.sort((a, b) => b.score - a.score);

            // Add to recommendations with proper format
            for (const { item, score } of scoredContent) {
              recommendations.push({
                id: item._id.toString(),
                score: score,
                type: contentType,
                data: item
              });

              // Limit to 3 series recommendations per content
              if (recommendations.length >= 3) break;
            }
          }
        }

        // Limit total sequel recommendations
        if (recommendations.length >= 10) break;
      } catch (error) {
        console.error(`Error processing item ${content._id || 'unknown'}: ${error.message}`);
        continue; // Skip this item but continue processing others
      }
    }

    console.log(`Found ${recommendations.length} total sequel recommendations for ${contentType}`);
    return recommendations;
  } catch (error) {
    console.error(`Error in findSequelsAndSeries for ${contentType}: ${error.message}`);
    return recommendations; // Return any recommendations we found before the error
  }
}

// Extract series name and number/season from title
function extractSeriesInfo(title) {
  // Patterns to match:
  // 1. Series with numbers (e.g., "The Witcher 3", "Spider-Man 2")
  const numberPattern = /^(.*?)(?:\s+|-|:)(?:\d+|[IVXLCDM]+)(?:\s+|-|:|$)/i;

  // 2. Series with "Season" or "Part" (e.g., "Breaking Bad Season 4", "Attack on Titan Part 2")
  const seasonPattern = /^(.*?)(?:\s+|-|:)(?:season|part|chapter)(?:\s+|-|:)(?:\d+|[IVXLCDM]+)(?:\s+|-|:|$)/i;

  // 3. Known franchise markers (e.g. "The Dark Knight", "Lord of the Rings: The Two Towers")
  const franchisePattern = /^(.*?)(?:\s+|-|:)(?:the|a|an|origins|returns|rises|forever|begins)(?:\s+|-|:|$)/i;

  let seriesName = null;
  let seriesNumber = null;

  // Try to match each pattern
  const matches = [
    title.match(numberPattern),
    title.match(seasonPattern),
    title.match(franchisePattern)
  ].filter(Boolean);

  if (matches.length > 0) {
    // Use the first match
    seriesName = matches[0][1].trim();

    // Try to extract number if present
    const numberMatch = title.match(/\d+|[IVXLCDM]+/i);
    if (numberMatch) {
      seriesNumber = numberMatch[0];
    }
  } else {
    // If no pattern matched but title is long enough, use whole title as series name
    if (title.length > 4) {
      seriesName = title;
    }
  }

  return { seriesName, seriesNumber };
}

// Calculate similarity score between content items based on metadata
function calculateMetadataSimilarity(content1, content2, contentType) {
  let score = 0;

  // Base similarity score
  score += 0.5;

  switch (contentType) {
    case 'anime':
      // Compare genres
      score += compareArrays(
        getFieldArrayValues(content1, 'genres', 'name'),
        getFieldArrayValues(content2, 'genres', 'name')
      ) * 0.15;

      // Compare demographics
      score += compareArrays(
        getFieldArrayValues(content1, 'demographics', 'name'),
        getFieldArrayValues(content2, 'demographics', 'name')
      ) * 0.15;

      // Compare themes
      score += compareArrays(
        getFieldArrayValues(content1, 'themes', 'name'),
        getFieldArrayValues(content2, 'themes', 'name')
      ) * 0.10;

      // Compare studios
      score += compareArrays(
        getFieldArrayValues(content1, 'studios', 'name'),
        getFieldArrayValues(content2, 'studios', 'name')
      ) * 0.10;
      break;

    case 'movie':
      // Compare genres
      score += compareArrays(
        content1.genres || [],
        content2.genres || []
      ) * 0.20;

      // Compare production companies
      score += compareArrays(
        getFieldArrayValues(content1, 'production_companies', 'name'),
        getFieldArrayValues(content2, 'production_companies', 'name')
      ) * 0.10;

      // Compare actors (if first 3 match, likely a series)
      score += compareArrays(
        getFieldArrayValues(content1, 'actors', 'name').slice(0, 3),
        getFieldArrayValues(content2, 'actors', 'name').slice(0, 3)
      ) * 0.20;
      break;

    case 'tvseries':
      // Compare genres
      score += compareArrays(
        content1.genres || [],
        content2.genres || []
      ) * 0.20;

      // Compare networks
      score += compareArrays(
        getFieldArrayValues(content1, 'networks', 'name'),
        getFieldArrayValues(content2, 'networks', 'name')
      ) * 0.15;

      // Compare production companies
      score += compareArrays(
        getFieldArrayValues(content1, 'production_companies', 'name'),
        getFieldArrayValues(content2, 'production_companies', 'name')
      ) * 0.05;

      // Compare actors (main cast similarity)
      score += compareArrays(
        getFieldArrayValues(content1, 'actors', 'name').slice(0, 5),
        getFieldArrayValues(content2, 'actors', 'name').slice(0, 5)
      ) * 0.10;
      break;

    case 'game':
      // Compare genres
      score += compareArrays(
        content1.genres || [],
        content2.genres || []
      ) * 0.20;

      // Compare platforms
      score += compareArrays(
        content1.platforms || [],
        content2.platforms || []
      ) * 0.15;

      // Compare developers
      score += compareArrays(
        content1.developers || [],
        content2.developers || []
      ) * 0.10;

      // Compare publishers
      score += compareArrays(
        content1.publishers || [],
        content2.publishers || []
      ) * 0.05;
      break;
  }

  return Math.min(0.99, score); // Cap at 0.99 to avoid exact match confusion
}

// Helper function to calculate similarity between two arrays
function compareArrays(array1 = [], array2 = []) {
  if (!array1.length || !array2.length) return 0;

  const set1 = new Set(array1);
  const set2 = new Set(array2);

  let intersectionCount = 0;
  for (const item of set1) {
    if (set2.has(item)) intersectionCount++;
  }

  const unionCount = set1.size + set2.size - intersectionCount;
  return unionCount === 0 ? 0 : intersectionCount / unionCount;
}

// Helper function to extract array field values
function getFieldArrayValues(obj, fieldName, subField = null) {
  const array = obj[fieldName] || [];
  if (!subField) return array;
  return array.map(item => item[subField]).filter(Boolean);
}

// Helper function to escape regex special characters
function escapeRegex(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Recommend based on user watch/play history
async function recommendForUser(userIds = [], topK = 10) {
  try {
    if (!userIds.length) return [];

    const userId = userIds[0];
    console.log(`🔎 Generating recommendations for user ${userId}`);

    // Get user content lists
    const userLists = await getUserContentLists(userId);
    if (!userLists) {
      console.warn(`No user found with ID: ${userId}`);
      return [];
    }

    // Extract content IDs and details
    const userData = await extractUserContent(userLists);
    console.log(`  • movies: ${userData.movieDetails.length}, tv: ${userData.tvSeriesDetails.length}, anime: ${userData.animeDetails.length}, games: ${userData.gameDetails.length}`);

    // If no content at all, return empty recommendations
    const totalContent = userData.movieDetails.length + userData.tvSeriesDetails.length +
                        userData.animeDetails.length + userData.gameDetails.length;

    if (totalContent === 0) {
      console.warn("User has no content to base recommendations on");
      return [];
    }

    // Create sets of user's content IDs for easy lookup
    const userContentSets = {
      movie: new Set(userData.movies.filter(Boolean)),
      tvseries: new Set(userData.tvSeries.filter(Boolean)),
      anime: new Set(userData.animes.filter(Boolean)),
      game: new Set(userData.games.filter(Boolean))
    };

    // Get topK recommendations for EACH content type (not divided)
    const perTypeCount = topK;

    console.log(`Getting up to ${perTypeCount} recommendations for each content type...`);

    // Get recommendations for each content type in parallel
    const recommendationPromises = [
      userData.movieDetails.length > 0 ?
        getRecommendationsByType(userData.movieDetails, 'movie', perTypeCount, userContentSets.movie)
          .catch(err => { console.error(`Error getting movie recommendations: ${err.message}`); return []; }) : [],
      userData.tvSeriesDetails.length > 0 ?
        getRecommendationsByType(userData.tvSeriesDetails, 'tvseries', perTypeCount, userContentSets.tvseries)
          .catch(err => { console.error(`Error getting TV series recommendations: ${err.message}`); return []; }) : [],
      userData.animeDetails.length > 0 ?
        getRecommendationsByType(userData.animeDetails, 'anime', perTypeCount, userContentSets.anime)
          .catch(err => { console.error(`Error getting anime recommendations: ${err.message}`); return []; }) : [],
      userData.gameDetails.length > 0 ?
        getRecommendationsByType(userData.gameDetails, 'game', perTypeCount, userContentSets.game)
          .catch(err => { console.error(`Error getting game recommendations: ${err.message}`); return []; }) : []
    ];

    // Wait for all recommendation types to complete
    const results = await Promise.all(recommendationPromises);
    const [movieRecs, tvRecs, animeRecs, gameRecs] = results;

    console.log(`Found recommendations - Movies: ${movieRecs.length}, TV: ${tvRecs.length}, Anime: ${animeRecs.length}, Games: ${gameRecs.length}`);

    // Combine all recommendations but keep track of content type
    const allRecommendations = {
      movies: movieRecs || [],
      tvSeries: tvRecs || [],
      animes: animeRecs || [],
      games: gameRecs || []
    };

    // Calculate total recommendations
    const totalRecommendations =
      allRecommendations.movies.length +
      allRecommendations.tvSeries.length +
      allRecommendations.animes.length +
      allRecommendations.games.length;

    // If no recommendations were found at all
    if (totalRecommendations === 0) {
      console.warn("No recommendations found for any content type");
      return [];
    }

    console.log(`Returning recommendations - Movies: ${allRecommendations.movies.length}, TV: ${allRecommendations.tvSeries.length}, Anime: ${allRecommendations.animes.length}, Games: ${allRecommendations.games.length}`);

    // Return all recommendations with content type information
    return {
      movies: allRecommendations.movies,
      tvSeries: allRecommendations.tvSeries,
      animes: allRecommendations.animes,
      games: allRecommendations.games,
      all: [...allRecommendations.movies, ...allRecommendations.tvSeries, ...allRecommendations.animes, ...allRecommendations.games]
    };
  } catch (error) {
    console.error(`recommendForUser error: ${error.message}`);
    return [];
  }
}

export { recommendForUser };