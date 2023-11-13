import { CronJob, CronTime } from "cron";

new CronTime("*/1 * * * *", "Asia/Calcutta");

const createCron = ({
  cronTime,
  timeZone = "Asia/Calcutta",
  onComplete = undefined
}: {
  /** 
  * Create crontab expressions from https://crontab.guru/
  */
  cronTime: string | Date | CronTime;
  /**
   * Timezone of the cron job
   * @default "Asia/Calcutta"
   */
  timeZone?: string;
  onComplete?: Function;

}) => {
    console.log({ cronTime, timeZone });

  new CronJob(
    cronTime, // cronTime
    function () {
      console.log("You will see this message every second");
    }, // onTick
    null, // onComplete
    true, // start
    timeZone // timeZone
  );
};

// createCron();

createCron({ 
  cronTime: new CronTime("*/1 * * * *", "Asia/Calcutta"),
  timeZone: "Asia/Calcutta",
})