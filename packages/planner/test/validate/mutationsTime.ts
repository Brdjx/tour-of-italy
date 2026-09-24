import { dayOf, stopOf } from "./fixtures";
import type { Mutation } from "./mutationRunner";
import { moveStop, shiftTrip } from "./mutationRunner";
import { tripMilan, tripNewYear, tripRome, tripTuscany } from "./trips";

// Mutations that break time: opening hours, weekdays, seasons, gaps between stops, day and meal
// windows, and malformed times. Each row is one corruption of a known-valid trip.

export const TIME_MUTATIONS: Mutation[] = [
  {
    name: "shift the Borghese Gallery past its 19:00 closing",
    build: tripRome,
    corrupt: (p) => moveStop(p, 0, 4, 1050),
    code: "CLOSED_AT_TIME",
    placeId: "place_007",
  },
  {
    name: "shift Mercato Testaccio lunch past its 14:00 closing",
    build: tripRome,
    corrupt: (p) => moveStop(p, 2, 2, 810),
    code: "CLOSED_AT_TIME",
    placeId: "place_015",
  },
  {
    name: "move the whole trip one day earlier, onto the Borghese Gallery's closed Monday",
    build: tripRome,
    corrupt: (p) => shiftTrip(p, -1),
    code: "CLOSED_AT_TIME",
    placeId: "place_007",
  },
  {
    name: "move the Tuscany trip to January (same weekdays), out of the Chianti season",
    build: tripTuscany,
    corrupt: (p) => shiftTrip(p, 217),
    code: "SEASONAL_CLOSED",
    placeId: "place_035",
  },
  {
    name: "move the Milan trip to November (same weekdays), out of the Lake Como season",
    build: tripMilan,
    corrupt: (p) => shiftTrip(p, 182),
    code: "SEASONAL_CLOSED",
    placeId: "place_064",
  },
  {
    name: "move the Milan trip a week later, off the Brera market's third weekend",
    build: tripMilan,
    corrupt: (p) => shiftTrip(p, 7),
    code: "SEASONAL_CLOSED",
    placeId: "place_059",
  },
  {
    name: "overlap Castel Sant'Angelo with lunch",
    build: tripRome,
    corrupt: (p) => moveStop(p, 1, 2, 900),
    code: "OVERLAP",
    placeId: "place_017",
  },
  {
    name: "squeeze the Colosseum to Roman Forum walk below its real 10 min",
    build: tripRome,
    corrupt: (p) => moveStop(p, 0, 1, 725),
    code: "OVERLAP",
    placeId: "place_004",
  },
  {
    name: "squeeze the Villa del Balbianello to Como leg below its real 55 min",
    build: tripMilan,
    corrupt: (p) => moveStop(p, 1, 1, 745),
    code: "OVERLAP",
    placeId: "place_085",
  },
  {
    name: "move lunch to 16:00",
    build: tripRome,
    corrupt: (p) => {
      dayOf(p, 1).stops.splice(2, 2); // clear the afternoon so only the meal rule breaks
      moveStop(p, 1, 1, 960);
    },
    code: "MEAL_OUTSIDE_WINDOW",
    placeId: "place_020",
  },
  {
    name: "end the last stop after a relaxed day ends at 22:00",
    build: tripTuscany,
    corrupt: (p) => moveStop(p, 2, 4, 1320),
    code: "OUTSIDE_DAY_WINDOW",
    placeId: "place_052",
  },
  {
    name: "end the last stop so late that the trip back to Bologna ends after 22:00",
    build: tripTuscany,
    corrupt: (p) => moveStop(p, 2, 4, 1290),
    code: "OUTSIDE_DAY_WINDOW",
    placeId: "place_052",
  },
  {
    name: "start the first stop after a 3 h 5 min transfer before the train arrives",
    build: tripNewYear,
    corrupt: (p) => moveStop(p, 1, 0, 600),
    code: "OUTSIDE_DAY_WINDOW",
    placeId: "place_066",
  },
  {
    name: "start the Chianti day trip before the traveler can get there from Florence",
    build: tripTuscany,
    corrupt: (p) => moveStop(p, 1, 0, 610),
    code: "OUTSIDE_DAY_WINDOW",
    placeId: "place_035",
  },
  {
    name: "give a stop a non-integer minute",
    build: tripMilan,
    corrupt: (p) => {
      stopOf(p, 0, 3).start = 890.25;
    },
    code: "INVALID_TIME",
    placeId: "place_058",
  },
  {
    name: "cut the Doge's Palace visit short",
    build: tripNewYear,
    corrupt: (p) => {
      stopOf(p, 1, 2).end = 900;
    },
    code: "INVALID_TIME",
    placeId: "place_067",
  },
];
