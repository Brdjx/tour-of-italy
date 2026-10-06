"use client";

import { useEffect, useState } from "react";
import { fetchWeatherForPlace } from "../lib/api";
import type { WeatherResponse } from "../lib/apiSchemas";

interface DayWeatherProps {
  lat: number;
  lng: number;
  date: string;
}

export function DayWeather({ lat, lng, date }: DayWeatherProps) {
  const [weather, setWeather] = useState<WeatherResponse | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setWeather(null);
    fetchWeatherForPlace(lat, lng, date, { signal: controller.signal })
      .then(setWeather)
      .catch(() => {});
    return () => controller.abort();
  }, [lat, lng, date]);

  // The weather is optional: loading, no forecast, or a failed request all show nothing.
  if (!weather?.available) return null;

  return (
    <p className="text-muted">
      {Math.round(weather.maxTempC)}°C · {weather.rainMm} mm rain
      {weather.rainMm >= 1 ? " · Rain likely" : ""}
    </p>
  );
}
