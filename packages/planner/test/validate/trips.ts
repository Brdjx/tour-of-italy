import type { DayPlan, Itinerary, Stop, StopRole, TripRequest } from "../../src/types";

// Known-valid itineraries, written by hand from the real data (never produced by the scheduler,
// so the validator is tested independently of it). Every time below was worked out from the
// place's listed hours, its visit length, and the travel model, and validItineraries.test.ts
// re-checks each stop against hoursOn without the validator. Each builder returns a fresh copy,
// so a test can corrupt it freely.

/** A stop from its parts: place, start, end, travel from the previous stop, role. */
export function stop(
  placeId: string,
  start: number,
  end: number,
  travel: number,
  role: StopRole,
): Stop {
  return { placeId, start, end, travelFromPrevMin: travel, role };
}

export function itinerary(request: TripRequest, days: DayPlan[]): Itinerary {
  return {
    request,
    days,
    source: "deterministic",
    warnings: [],
    meta: { attempts: 0, latencyMs: 12, generatedAt: "2026-09-23T10:00:00.000Z" },
  };
}

/**
 * Trip A: Rome for three days at a balanced pace, Tue 20 to Thu 22 Oct 2026. Day 1 is at the
 * visit cap (5 visits plus two meals). Must-include: Borghese Gallery (closed Mondays) and the
 * Vatican Museums (closed Sundays). No warnings.
 */
export function tripRome(): Itinerary {
  const request: TripRequest = {
    startDate: "2026-10-20",
    pace: "balanced",
    interests: ["art", "history"],
    maxPriceLevel: 3,
    anchors: "auto",
    mustInclude: ["place_007", "place_010"],
    exclude: ["place_025"],
  };
  return itinerary(request, [
    {
      date: "2026-10-20",
      anchorId: "rome",
      transferMin: 0,
      stops: [
        stop("place_001", 590, 710, 20, "visit"), // Colosseum 09:50 to 11:50
        stop("place_004", 730, 820, 10, "visit"), // Roman Forum 12:10 to 13:40
        stop("place_099", 850, 910, 20, "lunch"), // Eataly Ostiense 14:10 to 15:10
        stop("place_005", 940, 985, 20, "visit"), // Pantheon 15:40 to 16:25
        stop("place_007", 1015, 1135, 20, "visit"), // Borghese Gallery 16:55 to 18:55
        stop("place_003", 1170, 1260, 20, "dinner"), // Da Enzo al 29 19:30 to 21:00
        stop("place_077", 1285, 1315, 15, "visit"), // Trevi Fountain by Night 21:25 to 21:55
      ],
    },
    {
      date: "2026-10-21",
      anchorId: "rome",
      transferMin: 0,
      stops: [
        stop("place_010", 590, 830, 20, "visit"), // Vatican Museums 09:50 to 13:50
        stop("place_020", 850, 940, 10, "lunch"), // Il Sorpasso 14:10 to 15:40
        stop("place_017", 960, 1050, 10, "visit"), // Castel Sant'Angelo 16:00 to 17:30
        stop("place_008", 1070, 1115, 10, "visit"), // Piazza Navona 17:50 to 18:35
        stop("place_009", 1170, 1270, 15, "dinner"), // Osteria Fernanda 19:30 to 21:10
      ],
    },
    {
      date: "2026-10-22",
      anchorId: "rome",
      transferMin: 0,
      stops: [
        stop("place_006", 580, 640, 10, "visit"), // Campo de' Fiori Market 09:40 to 10:40
        stop("place_014", 670, 700, 20, "visit"), // Aventine Keyhole 11:10 to 11:40
        stop("place_015", 720, 780, 10, "lunch"), // Mercato Testaccio 12:00 to 13:00
        stop("place_002", 810, 990, 20, "visit"), // Trastevere 13:30 to 16:30
        stop("place_097", 1015, 1045, 15, "visit"), // Gianicolo 16:55 to 17:25
        stop("place_022", 1170, 1260, 15, "dinner"), // Roscioli Salumeria 19:30 to 21:00
      ],
    },
  ]);
}

/**
 * Trip B: Florence, Florence, then Bologna (a 1 h 40 min transfer) at a relaxed pace, Tue 9 to
 * Thu 11 Jun 2026. Day 2 is the Chianti bike trip (open April to October, hours unknown). The
 * traveler chose both bases, a budget of 2, the Uffizi and Chianti as must-includes, and
 * excluded the Siena day trip.
 */
export function tripTuscany(): Itinerary {
  const request: TripRequest = {
    startDate: "2026-06-09",
    pace: "relaxed",
    interests: ["food"],
    maxPriceLevel: 2,
    anchors: ["florence", "bologna"],
    mustInclude: ["place_026", "place_035"],
    exclude: ["place_038"],
  };
  return itinerary(request, [
    {
      date: "2026-06-09",
      anchorId: "florence",
      transferMin: 0,
      stops: [
        stop("place_026", 605, 785, 5, "visit"), // Uffizi 10:05 to 13:05
        stop("place_031", 810, 885, 15, "lunch"), // Mercato Centrale 13:30 to 14:45
        stop("place_084", 910, 940, 15, "visit"), // Ponte Vecchio 15:10 to 15:40
        stop("place_027", 965, 995, 15, "visit"), // Piazzale Michelangelo 16:05 to 16:35
        stop("place_033", 1140, 1230, 20, "dinner"), // Buca dell'Orafo 19:00 to 20:30
      ],
    },
    {
      date: "2026-06-10",
      anchorId: "florence",
      transferMin: 0,
      stops: [
        stop("place_035", 650, 1130, 50, "visit"), // Chianti by bike 10:50 to 18:50
        stop("place_039", 1190, 1310, 50, "dinner"), // Il Latini 19:50 to 21:50
      ],
    },
    {
      date: "2026-06-11",
      anchorId: "bologna",
      transferMin: 100,
      stops: [
        stop("place_048", 705, 750, 5, "visit"), // Torre degli Asinelli 11:45 to 12:30
        stop("place_047", 770, 860, 10, "lunch"), // Trattoria Anna Maria 12:50 to 14:20
        stop("place_051", 875, 995, 5, "visit"), // Pinacoteca di Bologna 14:35 to 16:35
        stop("place_050", 1140, 1230, 20, "dinner"), // Enoteca Italiana 19:00 to 20:30
        stop("place_052", 1260, 1290, 20, "visit"), // Piazza Maggiore at Night 21:00 to 21:30
      ],
    },
  ]);
}

/**
 * Trip C: Milan at a packed pace, Sat 16 to Mon 18 May 2026. Day 1 includes the Brera market,
 * open only on the third weekend; day 2 is a Lake Como day trip (Villa del Balbianello, open
 * April to October, reached 1 h 20 min after the day starts); day 3 is a Monday with no meals.
 */
export function tripMilan(): Itinerary {
  const request: TripRequest = {
    startDate: "2026-05-16",
    pace: "packed",
    interests: ["art", "shopping"],
    maxPriceLevel: 3,
    anchors: ["milan"],
    mustInclude: ["place_064"],
    exclude: [],
  };
  return itinerary(request, [
    {
      date: "2026-05-16",
      anchorId: "milan",
      transferMin: 0,
      stops: [
        stop("place_059", 540, 630, 10, "visit"), // Brera Antique Market 09:00 to 10:30
        stop("place_055", 655, 745, 15, "visit"), // Duomo 10:55 to 12:25
        stop("place_061", 765, 865, 10, "lunch"), // Trattoria Milanese 12:45 to 14:25
        stop("place_058", 890, 1040, 15, "visit"), // Pinacoteca di Brera 14:50 to 17:20
        stop("place_060", 1060, 1105, 10, "visit"), // Galleria 17:40 to 18:25
        stop("place_057", 1130, 1250, 15, "visit"), // Navigli at aperitivo hour 18:50 to 20:50
        stop("place_082", 1280, 1340, 20, "dinner"), // Rossopomodoro 21:20 to 22:20
      ],
    },
    {
      date: "2026-05-17",
      anchorId: "milan",
      transferMin: 0,
      stops: [
        stop("place_064", 600, 720, 80, "visit"), // Villa del Balbianello 10:00 to 12:00
        stop("place_085", 785, 815, 55, "visit"), // Como lakefront 13:05 to 13:35
        stop("place_100", 1140, 1320, 65, "dinner"), // Aperitivo Culture Walk 19:00 to 22:00
      ],
    },
    {
      date: "2026-05-18",
      anchorId: "milan",
      transferMin: 0,
      stops: [
        stop("place_098", 600, 660, 20, "visit"), // Sant'Ambrogio 10:00 to 11:00
        stop("place_094", 690, 735, 20, "visit"), // Rinascente roof 11:30 to 12:15
        stop("place_062", 765, 885, 20, "visit"), // Fondazione Prada 12:45 to 14:45
        stop("place_102", 915, 1005, 20, "visit"), // Quadrilatero 15:15 to 16:45
      ],
    },
  ]);
}

/**
 * Trip D: Rome over New Year's Eve, then Venice (a 3 h 5 min transfer) at a packed pace, Thu 31
 * Dec 2026 to Sat 2 Jan 2027. The traveler asked for the low-rated Hard Rock Cafe.
 */
export function tripNewYear(): Itinerary {
  const request: TripRequest = {
    startDate: "2026-12-31",
    pace: "packed",
    interests: [],
    maxPriceLevel: null,
    anchors: "auto",
    mustInclude: ["place_025"],
    exclude: [],
  };
  return itinerary(request, [
    {
      date: "2026-12-31",
      anchorId: "rome",
      transferMin: 0,
      stops: [
        stop("place_005", 540, 585, 5, "visit"), // Pantheon 09:00 to 09:45
        stop("place_025", 720, 810, 15, "lunch"), // Hard Rock Cafe 12:00 to 13:30
        stop("place_080", 840, 960, 20, "visit"), // Villa Borghese 14:00 to 16:00
        stop("place_019", 990, 1010, 20, "visit"), // Spanish Steps 16:30 to 16:50
        stop("place_018", 1030, 1060, 10, "visit"), // Trevi Fountain 17:10 to 17:40
        stop("place_022", 1170, 1260, 15, "dinner"), // Roscioli 19:30 to 21:00
      ],
    },
    {
      date: "2027-01-01",
      anchorId: "venice",
      transferMin: 185,
      stops: [
        stop("place_066", 700, 760, 5, "visit"), // Rialto Bridge 11:40 to 12:40
        stop("place_076", 775, 835, 5, "lunch"), // Osteria Alla Staffa 12:55 to 13:55
        stop("place_067", 850, 1000, 5, "visit"), // Doge's Palace 14:10 to 16:40
        stop("place_068", 1140, 1320, 15, "dinner"), // Cicchetti crawl 19:00 to 22:00
      ],
    },
    {
      date: "2027-01-02",
      anchorId: "venice",
      transferMin: 0,
      stops: [
        stop("place_088", 570, 615, 15, "visit"), // San Giorgio Maggiore 09:30 to 10:15
        stop("place_069", 640, 760, 15, "visit"), // Peggy Guggenheim 10:40 to 12:40
        stop("place_096", 780, 900, 10, "lunch"), // Al Quadri 13:00 to 15:00
        stop("place_072", 925, 1105, 15, "visit"), // Dorsoduro 15:25 to 18:25
        stop("place_079", 1140, 1230, 20, "dinner"), // Cremeria Mascareta 19:00 to 20:30
        stop("place_071", 1260, 1320, 20, "visit"), // Gondola 21:00 to 22:00
      ],
    },
  ]);
}
