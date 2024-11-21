import Game from '../models/Game.js';
import Player from '../models/Player.js';
import Round from '../models/Round.js';

// Function to clean up old games and related data
export const cleanupOldGames = async () => {
    try {
        // Calculate date 7 days ago
        const oneWeekAgo = new Date();
        oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);

        // Find old games
        const oldGames = await Game.find({ 
            createdAt: { $lt: oneWeekAgo } 
        });

        // Get array of game IDs
        const gameIds = oldGames.map(game => game._id);

        if (gameIds.length > 0) {
            // Delete related data
            await Promise.all([
                Player.deleteMany({ gameId: { $in: gameIds } }),
                Round.deleteMany({ gameId: { $in: gameIds } }),
                Game.deleteMany({ _id: { $in: gameIds } })
            ]);

            console.log(`Cleanup completed. Removed ${gameIds.length} old games and related data.`);
        } else {
            console.log('No old games to clean up.');
        }
    } catch (error) {
        console.error('Database cleanup failed:', error);
    }
};
