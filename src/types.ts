// Normalized types shared by all operator adapters. Times are Europe/Brussels local "HH:mm".

export type Operator = "sncb" | "stib" | "delijn";
export type Mode = "train" | "metro" | "tram" | "bus";

export interface Stop {
  id: string; // operator id, e.g. BE.NMBS.008814001
  operator: Operator;
  name: string; // display name
  names: string[]; // all known names (en/nl/fr/official)
  lat: number;
  lon: number;
  namesByLang?: { fr?: string; nl?: string; en?: string };
  points?: string[]; // STIB: platform/direction point ids grouped under this name
  lines?: string[]; // STIB: line labels serving the stop, e.g. "M2", "B71"
}

export interface Departure {
  operator: Operator;
  mode: Mode;
  line: string; // "IC 1517", "S1 1978"; STIB labels "M2", "T81", "B71"
  vehicleId?: string; // "IC1517"
  destination: string; // final destination (or origin, for arrivals)
  date: string; // YYYY-MM-DD
  scheduledTime: string; // HH:mm
  realtimeTime: string; // HH:mm (scheduled + delay)
  delayMin: number;
  platform?: string;
  platformChanged: boolean;
  cancelled: boolean;
  departed?: boolean;
  occupancy?: "low" | "medium" | "high";
  ts?: number; // unix s: expected time (live if known, else scheduled)
  schedTs?: number; // unix s: scheduled time (absent for STIB, which only gives waiting times)
  live?: boolean; // true = realtime data, false = timetable only
  arrivalTs?: number; // De Lijn with `to`: unix s at the destination
  inMin?: number; // STIB: minutes until departure (live waiting time)
  note?: string; // STIB: "last" = last departure of the day
  tripKey?: string; // De Lijn: "2026-10-06_2555_61" (same trip at every stop)
  seq?: number; // De Lijn: stop sequence within the trip
  arrivalTime?: string; // De Lijn with `to`: HH:mm at the destination (scheduled + current delay)
  arrivalStop?: string;
  stopId: string;
  stopName: string;
}

export interface Board {
  stopId: string;
  stopName: string;
  kind: "departures" | "arrivals";
  items: Departure[];
  total: number;
}

export interface JourneyPoint {
  station: string;
  stationId: string;
  schedTs?: number; // unix s
  lat?: number;
  lon?: number;
  scheduledTime: string;
  realtimeTime: string;
  delayMin: number;
  platform?: string;
  platformChanged: boolean;
  cancelled: boolean;
}

export interface JourneyLeg {
  line: string; // "IC 1517" or "walk"
  lineType?: string; // "IC", "S1", "L"…
  vehicleId?: string;
  direction?: string;
  from: JourneyPoint;
  to: JourneyPoint;
}

export interface Journey {
  date: string;
  from: JourneyPoint;
  to: JourneyPoint;
  durationMin: number;
  transfers: number;
  legs: JourneyLeg[];
  alerts: string[];
}

export interface StopEvent {
  schedTs: number;
  delayMin: number;
  cancelled: boolean;
}

export interface TrainStop {
  station: string;
  stationId: string;
  lat?: number;
  lon?: number;
  arrival?: StopEvent & { platform?: string; platformChanged: boolean };
  departure?: StopEvent & { platform?: string; platformChanged: boolean };
  scheduledTime: string; // departure time, or arrival time at the terminus
  realtimeTime: string;
  delayMin: number;
  platform?: string;
  platformChanged: boolean;
  cancelled: boolean;
  passed: boolean;
}

export interface TrainStatus {
  vehicleId: string;
  line: string;
  date: string;
  origin: string;
  destination: string;
  currentDelayMin: number;
  stops: TrainStop[];
}

export interface Disruption {
  id?: string; // stable across calls
  operator: Operator;
  type: "incident" | "planned";
  title: string;
  description: string;
  link?: string;
  updated: string; // YYYY-MM-DD HH:mm
  validFrom?: number; // unix s
  validUntil?: number; // unix s
  lines?: string[];
  stopIds?: string[]; // operator stop/point ids mentioned
}

export interface CompositionSegment {
  origin: string;
  destination: string;
  units: number;
  materialTypes: string[];
  firstClassUnits: number[]; // 1-based positions
  seatsFirst: number;
  seatsSecond: number;
  toiletUnits: number;
  bikeUnits: number[];
  lengthM: number;
}

export interface Composition {
  vehicleId: string;
  segments: CompositionSegment[];
}
