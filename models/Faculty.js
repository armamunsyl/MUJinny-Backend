const mongoose = require('mongoose');

const facultySchema = new mongoose.Schema(
    {
        university:        { type: String, default: 'Metropolitan University' },
        name:              { type: String, required: true, trim: true },
        designation:       { type: String, default: '', trim: true },
        department:        { type: String, default: '', trim: true },
        email:             [{ type: String, trim: true, lowercase: true }],
        phone:             [{ type: String, trim: true }],
        profileUrl:        { type: String, required: true, unique: true, trim: true },
        photoUrl:          { type: String, default: '' },
        officeLocation:    { type: String, default: '' },
        bio:               { type: String, default: '' },
        education:         [{ type: String }],
        researchInterests: [{ type: String }],
        publications:      [{ type: String }],
        awards:            [{ type: String }],
        socialLinks:       { type: Map, of: String, default: {} },
        searchKeys:        [{ type: String }],
        lastScrapedAt:     { type: Date, default: null },
    },
    { timestamps: true }
);

facultySchema.index({ name: 'text', searchKeys: 'text', designation: 'text', department: 'text' });
facultySchema.index({ department: 1 });
facultySchema.index({ email: 1 });
facultySchema.index({ phone: 1 });
facultySchema.index({ profileUrl: 1 }, { unique: true });
facultySchema.index({ searchKeys: 1 });

module.exports = mongoose.model('Faculty', facultySchema);
