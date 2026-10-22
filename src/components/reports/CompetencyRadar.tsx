"use client";

import {
  RadarChart,
  PolarGrid,
  PolarAngleAxis,
  Radar,
  ResponsiveContainer,
  Tooltip,
} from "recharts";

interface Props {
  competencyScores: Record<string, number>;
}

export default function CompetencyRadar({ competencyScores }: Props) {
  const entries = Object.entries(competencyScores);

  if (entries.length === 0) {
    return (
      <div className="flex h-40 items-center justify-center text-sm text-gray-400">
        No competency data
      </div>
    );
  }

  const data = entries.map(([competency, score]) => ({
    subject: competency,
    score: Number(score),
    fullMark: 10,
  }));

  return (
    <ResponsiveContainer width="100%" height={260}>
      <RadarChart data={data} margin={{ top: 10, right: 30, bottom: 10, left: 30 }}>
        <PolarGrid stroke="#E5E7EB" />
        <PolarAngleAxis
          dataKey="subject"
          tick={{ fontSize: 11, fill: "#6B7280" }}
        />
        <Radar
          dataKey="score"
          stroke="#2563EB"
          fill="#2563EB"
          fillOpacity={0.2}
          strokeWidth={2}
        />
        <Tooltip
          formatter={(v) => [`${v} / 10`, "Score"]}
          contentStyle={{ fontSize: 12 }}
        />
      </RadarChart>
    </ResponsiveContainer>
  );
}
