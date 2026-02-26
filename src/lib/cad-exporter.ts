import { GeometricReconstruction } from '@/ai/flows/infralith/reconstruction-types';

/**
 * Reversible Geometry Generator: Translates proprietary 3D JSON state back into universal 2D CAD formats.
 */

export function exportToSVG(data: GeometricReconstruction, floorLevel: number | null = null): string {
    const padding = 2;
    // Calculate bounding box
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

    const walls = floorLevel === null ? data.walls : data.walls.filter(w => w.floor_level === floorLevel);

    walls.forEach(w => {
        minX = Math.min(minX, w.start[0], w.end[0]);
        minY = Math.min(minY, w.start[1], w.end[1]);
        maxX = Math.max(maxX, w.start[0], w.end[0]);
        maxY = Math.max(maxY, w.start[1], w.end[1]);
    });

    if (minX === Infinity) return '<svg></svg>';

    const width = maxX - minX + padding * 2;
    const height = maxY - minY + padding * 2;
    const viewBox = `${minX - padding} ${minY - padding} ${width} ${height}`;

    let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="100%" height="100%" style="background-color: white;">`;
    svg += `<g stroke="black" stroke-linecap="round" stroke-linejoin="round">`;

    // Draw Rooms (light fill)
    const rooms = floorLevel === null ? data.rooms : data.rooms.filter(r => r.floor_level === floorLevel);
    rooms.forEach(room => {
        const points = room.polygon.map(p => `${p[0]},${p[1]}`).join(' ');
        svg += `<polygon points="${points}" fill="#f0f0f0" stroke="none" />`;
        // Text label
        const cx = room.polygon.reduce((sum, p) => sum + p[0], 0) / room.polygon.length;
        const cy = room.polygon.reduce((sum, p) => sum + p[1], 0) / room.polygon.length;
        svg += `<text x="${cx}" y="${cy}" font-size="0.5" fill="#555" text-anchor="middle" dominant-baseline="middle">${room.name}</text>`;
        if (room.area > 0) {
            svg += `<text x="${cx}" y="${cy + 0.6}" font-size="0.3" fill="#888" text-anchor="middle" dominant-baseline="middle">${room.area.toFixed(1)}m²</text>`;
        }
    });

    // Draw Walls
    walls.forEach(w => {
        svg += `<line x1="${w.start[0]}" y1="${w.start[1]}" x2="${w.end[0]}" y2="${w.end[1]}" stroke-width="${w.thickness}" />`;
    });

    // Draw Windows (Cyan)
    const windows = floorLevel === null ? data.windows : data.windows.filter(w => w.floor_level === floorLevel);
    windows.forEach(win => {
        svg += `<rect x="${win.position[0] - win.width / 2}" y="${win.position[1] - 0.1}" width="${win.width}" height="0.2" fill="#00ffff" stroke="none" />`;
    });

    // Draw Doors (Orange)
    const doors = floorLevel === null ? data.doors : data.doors.filter(d => d.floor_level === floorLevel);
    doors.forEach(door => {
        // Draw door swing arc
        svg += `<path d="M ${door.position[0]} ${door.position[1]} A ${door.width} ${door.width} 0 0 1 ${door.position[0] + door.width} ${door.position[1] + door.width}" fill="none" stroke="#ffa500" stroke-width="0.05" />`;
        svg += `<line x1="${door.position[0]}" y1="${door.position[1]}" x2="${door.position[0]}" y2="${door.position[1] + door.width}" stroke="#ffa500" stroke-width="0.1" />`;
    });

    svg += `</g></svg>`;
    return svg;
}

export function exportToDXF(data: GeometricReconstruction, floorLevel: number | null = null): string {
    // dxf-writer uses node imports, which can be tricky in the browser. 
    // We will construct a basic ASCII DXF string manually for perfect client-side execution.
    // DXF files are basically key-value pairs separated by newlines.

    let dxf = "  0\nSECTION\n  2\nENTITIES\n";

    const walls = floorLevel === null ? data.walls : data.walls.filter(w => w.floor_level === floorLevel);

    // Write walls as lines
    walls.forEach(w => {
        dxf += "  0\nLINE\n  8\nWalls\n 10\n" + w.start[0] + "\n 20\n" + w.start[1] + "\n 30\n0.0\n 11\n" + w.end[0] + "\n 21\n" + w.end[1] + "\n 31\n0.0\n";
    });

    dxf += "  0\nENDSEC\n  0\nEOF\n";

    return dxf;
}

export function downloadStringAsFile(content: string, filename: string, mimeType: string) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}
