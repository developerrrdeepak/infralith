'use client';

import React, { createContext, useContext, useState, ReactNode } from 'react';
import { GeometricReconstruction, RoomGeometry, WallGeometry } from '@/ai/flows/infralith/reconstruction-types';

type CloudOperationResult = {
    ok: boolean;
    error?: string;
};

interface BIMContextType {
    model: GeometricReconstruction | null;
    setModel: (model: GeometricReconstruction | null) => void;
    activeFloor: number | null; // null means all floors visible
    setActiveFloor: (floor: number | null) => void;
    selectedElement: { type: 'room' | 'wall', data: RoomGeometry | WallGeometry } | null;
    setSelectedElement: (element: { type: 'room' | 'wall', data: RoomGeometry | WallGeometry } | null) => void;
    updateWallColor: (id: string | number, color: string) => void;
    updateRoomColor: (id: string | number, color: string) => void;
    saveToCloud: (modelName?: string) => Promise<CloudOperationResult>;
    loadModel: (id: string) => Promise<CloudOperationResult>;
}

const BIMContext = createContext<BIMContextType | undefined>(undefined);

export function BIMProvider({ children }: { children: ReactNode }) {
    const [model, setModel] = useState<GeometricReconstruction | null>(null);
    const [activeFloor, setActiveFloor] = useState<number | null>(null);
    const [selectedElement, setSelectedElement] = useState<{ type: 'room' | 'wall', data: RoomGeometry | WallGeometry } | null>(null);

    const updateWallColor = (id: string | number, color: string) => {
        if (!model) return;
        setModel({
            ...model,
            walls: model.walls.map(w => w.id === id ? { ...w, color } : w)
        });
    };

    const updateRoomColor = (id: string | number, color: string) => {
        if (!model) return;
        setModel({
            ...model,
            rooms: model.rooms.map(r => r.id === id ? { ...r, floor_color: color } : r)
        });
    };

    const saveToCloud = async (modelName?: string): Promise<CloudOperationResult> => {
        if (!model) return { ok: false, error: 'No model is available to save.' };
        try {
            const res = await fetch('/api/infralith/save-model', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    modelName: modelName || model.building_name || 'Infralith BIM Model',
                    data: model
                })
            });
            const payload = await res.json().catch(() => null);
            if (!res.ok) {
                return {
                    ok: false,
                    error: payload?.error || `Save failed with status ${res.status}.`,
                };
            }
            return { ok: true };
        } catch (error) {
            console.error("Failed to sync BIM to Cosmos DB", error);
            return { ok: false, error: 'Network error while saving to Cosmos DB.' };
        }
    };

    const loadModel = async (id: string): Promise<CloudOperationResult> => {
        try {
            const res = await fetch(`/api/infralith/load-model?id=${id}`);
            const payload = await res.json().catch(() => null);
            if (!res.ok) {
                return {
                    ok: false,
                    error: payload?.error || `Load failed with status ${res.status}.`,
                };
            }
            if (payload && payload.data) {
                setModel(payload.data);
                return { ok: true };
            }
            return { ok: false, error: 'Loaded payload did not contain model data.' };
        } catch (error) {
            console.error("Failed to load BIM from Cosmos DB", error);
            return { ok: false, error: 'Network error while loading from Cosmos DB.' };
        }
    };

    return (
        <BIMContext.Provider value={{
            model,
            setModel,
            activeFloor,
            setActiveFloor,
            selectedElement,
            setSelectedElement,
            updateWallColor,
            updateRoomColor,
            saveToCloud,
            loadModel
        }}>
            {children}
        </BIMContext.Provider>
    );
}

export function useBIM() {
    const context = useContext(BIMContext);
    if (!context) {
        throw new Error('useBIM must be used within a BIMProvider');
    }
    return context;
}
