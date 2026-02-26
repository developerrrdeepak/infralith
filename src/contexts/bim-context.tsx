'use client';

import React, { createContext, useContext, useState, ReactNode } from 'react';
import { GeometricReconstruction, RoomGeometry, WallGeometry } from '@/ai/flows/infralith/reconstruction-types';

interface BIMContextType {
    model: GeometricReconstruction | null;
    setModel: (model: GeometricReconstruction | null) => void;
    activeFloor: number | null; // null means all floors visible
    setActiveFloor: (floor: number | null) => void;
    selectedElement: { type: 'room' | 'wall', data: RoomGeometry | WallGeometry } | null;
    setSelectedElement: (element: { type: 'room' | 'wall', data: RoomGeometry | WallGeometry } | null) => void;
    updateWallColor: (id: string | number, color: string) => void;
    updateRoomColor: (id: string | number, color: string) => void;
    saveToCloud: (modelName?: string) => Promise<boolean>;
    loadModel: (id: string) => Promise<boolean>;
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

    const saveToCloud = async (modelName?: string): Promise<boolean> => {
        if (!model) return false;
        try {
            const res = await fetch('/api/infralith/save-model', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    modelName: modelName || model.building_name || 'Infralith BIM Model',
                    data: model
                })
            });
            return res.ok;
        } catch (error) {
            console.error("Failed to sync BIM to Cosmos DB", error);
            return false;
        }
    };

    const loadModel = async (id: string): Promise<boolean> => {
        try {
            const res = await fetch(`/api/infralith/load-model?id=${id}`);
            if (!res.ok) return false;
            const doc = await res.json();
            if (doc && doc.data) {
                setModel(doc.data);
                return true;
            }
            return false;
        } catch (error) {
            console.error("Failed to load BIM from Cosmos DB", error);
            return false;
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
