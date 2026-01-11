import { registerRewardsRoutes } from "./services/rewardsRoutes";
import { rewardsEngine } from "./services/rewardsEngine";


registerRewardsRoutes(app);
rewardsEngine.start();
